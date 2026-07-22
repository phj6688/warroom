// E2E: settings "Test" button against a sandbox with a stub gateway.
// Run: node tests/e2e/test-connection.e2e.mjs
// (spawns its own stub gateway on a fixed port and the app on :8092)
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const APP = 8092, STUB = 8093;
const BASE = `http://localhost:${APP}`;
const SHOT = (n) => `/tmp/warroom-e2e-test-conn-${n}.png`;
const fail = (msg) => { console.error('E2E-FAIL:', msg); process.exit(1); };

// Stub gateway: 200 only for model "good-model".
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const model = (() => { try { return JSON.parse(body).model; } catch { return null; } })();
    if (req.url.endsWith('/chat/completions') && model === 'good-model') {
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
    WAR_ROOM_DB_PATH: `/tmp/warroom-e2e-test-conn.db`,
    OPENAI_BASE_URL: `http://127.0.0.1:${STUB}/v1`,
    OPENAI_API_KEY: 'stub-key',
    MODEL: 'good-model',
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
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
await page.click('#settings-btn');
await page.waitForSelector('.settings-all-row .sa-test', { timeout: 10000 });

// 1. Master row, default route + empty model -> tests the deployment default -> green.
const masterTest = page.locator('.settings-all-row .sa-test');
await masterTest.click();
await page.waitForFunction(() => {
  const b = document.querySelector('.settings-all-row .sa-test');
  return b && (b.classList.contains('ok') || b.classList.contains('fail'));
}, { timeout: 20000 });
if (!(await masterTest.evaluate((b) => b.classList.contains('ok')))) fail('default-route test should pass via stub');
const okLabel = await masterTest.textContent();
if (!/^✓ \d+ms$/.test(okLabel.trim())) fail(`ok label malformed: ${okLabel}`);
await page.screenshot({ path: SHOT('1-master-ok') });

// 2. Master row with a wrong model id -> red + toast carries the provider error.
await page.fill('#settings-all-model', 'typo-model');
await masterTest.click();
await page.waitForFunction(() => {
  const b = document.querySelector('.settings-all-row .sa-test');
  return b && b.classList.contains('fail');
}, { timeout: 20000 });
const toast = await page.locator('#toast').textContent();
if (!/typo-model/.test(toast)) fail(`toast missing provider detail: ${toast}`);
await page.screenshot({ path: SHOT('2-master-bad-model') });

// 3. Per-agent row guard: route set, model empty -> warn, no request fired.
const firstRow = page.locator('#settings-agents .settings-agent-row').first();
await firstRow.locator('.sa-route').selectOption('ollama-local');
await firstRow.locator('.sa-test').click();
const guardToast = await page.locator('#toast').textContent();
if (!/needs a model to test/.test(guardToast)) fail(`guard toast missing: ${guardToast}`);

// 4. Per-agent row happy path on the default route.
await firstRow.locator('.sa-route').selectOption('');
await firstRow.locator('.sa-model').fill('good-model');
await firstRow.locator('.sa-test').click();
await page.waitForFunction(() => {
  const b = document.querySelector('#settings-agents .settings-agent-row .sa-test');
  return b && b.classList.contains('ok');
}, { timeout: 20000 });
await page.screenshot({ path: SHOT('3-agent-row-ok') });

await browser.close();
cleanup();
console.log('E2E-PASS');
