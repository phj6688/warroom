// E2E: the Settings panel dry-runs a model change before it saves.
// Run: node tests/e2e/preflight-dry-run.e2e.mjs
//
// A stub gateway answers only for "good-model", so a typed model id that the
// provider does not serve reproduces the real failure without a live provider.
// Proof captured as screenshots: the failure panel with the provider's own
// error, and the passing panel after the id is corrected.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';

// Fixed ports collide with a parallel job or a stray local process and fail
// before the spec reaches an assertion. Bind :0 and let the OS pick.
const freePort = () => new Promise((resolve, reject) => {
  const srv = createNetServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
const APP = await freePort(), STUB = await freePort();
const BASE = `http://localhost:${APP}`;
const SHOT = (n) => `/tmp/warroom-e2e-preflight-${n}.png`;
const fail = (msg) => { console.error('E2E-FAIL:', msg); process.exit(1); };

const DB = '/tmp/warroom-e2e-preflight.db';
// Step 4 stores a deliberately failing configuration, so a leftover DB would
// make step 1's "nothing was stored" assertion fail on the next run.
for (const f of [DB, DB + '-wal', DB + '-shm']) rmSync(f, { force: true });

const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'good-model' }, { id: 'second-good-model' }] }));
      return;
    }
    const model = (() => { try { return JSON.parse(body).model; } catch { return null; } })();
    if (req.url.endsWith('/chat/completions') && (model === 'good-model' || model === 'second-good-model')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `model ${model} not found` } }));
    }
  });
});
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

const app = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(APP),
    WAR_ROOM_DB_PATH: DB,
    OPENAI_BASE_URL: `http://127.0.0.1:${STUB}/v1`,
    OPENAI_API_KEY: 'stub-key',
    MODEL: 'good-model',
    OPENROUTER_API_KEY: '',
    ANTHROPIC_API_KEY: '',
  },
  stdio: 'ignore',
});
const cleanup = () => { try { app.kill(); } catch {} try { stub.close(); } catch {} };
process.on('exit', cleanup);

for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
await page.click('#settings-btn');
await page.waitForSelector('#settings-agents .settings-agent-row', { timeout: 10000 });

const panel = page.locator('#settings-preflight');
const verdict = page.locator('#settings-preflight-verdict');
const forceBtn = page.locator('#settings-force');

if (await panel.isVisible()) fail('the dry-run panel must start hidden');
if (await forceBtn.isVisible()) fail('Save anyway must start hidden');

// 1. A model id the provider does not serve: Save must refuse, keep the panel
//    open, and show the provider's own error.
const firstRow = page.locator('#settings-agents .settings-agent-row').first();
const agentId = await firstRow.getAttribute('data-aid');
await firstRow.locator('.sa-model').fill('typo-model');
await page.click('#settings-save');
await page.waitForFunction(() => {
  const el = document.getElementById('settings-preflight');
  return el && !el.hidden && (el.classList.contains('fail') || el.classList.contains('ok'));
}, { timeout: 30000 });

if (!(await panel.evaluate((el) => el.classList.contains('fail')))) fail('an unreachable model must fail the dry run');
const verdictText = (await verdict.textContent()).trim();
if (!/Dry run failed/.test(verdictText)) fail(`verdict text wrong: ${verdictText}`);
const bodyText = await page.locator('#settings-preflight-body').textContent();
if (!/typo-model/.test(bodyText)) fail('the report must name the failing model');
if (!/not found/.test(bodyText)) fail(`the report must carry the provider error: ${bodyText.slice(0, 200)}`);
if (!(await forceBtn.isVisible())) fail('Save anyway must appear after a failed dry run');
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT('1-failed') });

// The modal must still be open, and nothing may have been stored.
if (!(await page.locator('#settings-overlay').evaluate((el) => el.classList.contains('open')))) {
  fail('the settings modal must stay open on a failed dry run');
}
const storedAfterFail = await (await fetch(BASE + '/api/settings/agent-routing')).json();
if (storedAfterFail.routing[agentId]) fail('a rejected configuration must not be stored');

// 2. Fix the id: the dry run passes and the modal closes.
await firstRow.locator('.sa-model').fill('second-good-model');
await page.click('#settings-save');
await page.waitForFunction(() => !document.getElementById('settings-overlay').classList.contains('open'), { timeout: 30000 });
const storedAfterOk = await (await fetch(BASE + '/api/settings/agent-routing')).json();
if (storedAfterOk.routing[agentId]?.model !== 'second-good-model') fail('a passing configuration must be stored');
await page.screenshot({ path: SHOT('2-saved') });

// 3. The standalone Dry run button reports without saving.
await page.click('#settings-btn');
await page.waitForSelector('#settings-agents .settings-agent-row', { timeout: 10000 });
const row2 = page.locator('#settings-agents .settings-agent-row').first();
await row2.locator('.sa-model').fill('another-typo');
await page.click('#settings-dryrun');
await page.waitForFunction(() => {
  const el = document.getElementById('settings-preflight');
  return el && !el.hidden && el.classList.contains('fail');
}, { timeout: 30000 });
const stillStored = await (await fetch(BASE + '/api/settings/agent-routing')).json();
if (stillStored.routing[agentId]?.model !== 'second-good-model') fail('the Dry run button must not save');
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT('3-dryrun-only') });

// 3b. Correct the id and the same button reports a pass.
await row2.locator('.sa-model').fill('good-model');
await page.click('#settings-dryrun');
await page.waitForFunction(() => {
  const el = document.getElementById('settings-preflight');
  return el && !el.hidden && el.classList.contains('ok');
}, { timeout: 30000 });
const okBody = await page.locator('#settings-preflight-body').textContent();
if (!/Problem Framing/i.test(okBody)) fail('a passing report still lists every phase');
await page.waitForTimeout(600);
await page.screenshot({ path: SHOT('3b-dryrun-pass') });
await row2.locator('.sa-model').fill('another-typo');
await page.click('#settings-dryrun');
await page.waitForFunction(() => {
  const el = document.getElementById('settings-preflight');
  return el && !el.hidden && el.classList.contains('fail');
}, { timeout: 30000 });

// 4. Save anyway stores the failing configuration on purpose.
await page.click('#settings-save');
await page.waitForSelector('#settings-force:not([hidden])', { timeout: 30000 });
await page.click('#settings-force');
await page.waitForFunction((id) => true, agentId, { timeout: 1000 }).catch(() => {});
await page.waitForFunction(async () => {
  const r = await fetch('/api/settings/agent-routing');
  const j = await r.json();
  return Object.values(j.routing).some((e) => e && e.model === 'another-typo');
}, null, { timeout: 30000 });
await page.screenshot({ path: SHOT('4-forced') });

await browser.close();
cleanup();
console.log('E2E-PASS');
