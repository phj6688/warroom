// E2E: apply-all settings flow against a sandbox instance on :8091.
// Run: PORT=8091 WAR_ROOM_DB_PATH=/tmp/e2e.db ANTHROPIC_API_KEY=dummy node server.js &
//      node tests/e2e/apply-all.e2e.mjs
// Steps: open modal -> screenshot -> apply route+model to all 8 agents ->
// screenshot -> Save -> assert /api/settings/agent-routing persisted all 8 ->
// clear-all -> Save -> assert routing is {} again. Exits non-zero on any miss.
import { chromium } from 'playwright';

const BASE = 'http://localhost:8091';
const SHOT = (n) => `/tmp/warroom-e2e-${n}.png`;
const fail = (msg) => { console.error('E2E-FAIL:', msg); process.exit(1); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('dialog', d => d.dismiss());

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 30000 });
await page.click('#settings-btn');
await page.waitForSelector('#settings-all-apply', { timeout: 10000 });
await page.screenshot({ path: SHOT('1-modal-open') });

const rowCount = await page.locator('#settings-agents .settings-agent-row').count();
if (rowCount !== 8) fail(`expected 8 agent rows, got ${rowCount}`);

// Guard: non-default route with empty model must warn, not fill.
await page.selectOption('#settings-all-route', 'anthropic-api');
await page.click('#settings-all-apply');
const toast1 = await page.locator('#toast').textContent();
if (!/needs a model/.test(toast1)) fail(`missing-model guard toast, got: ${toast1}`);

// Fill all: route + model.
await page.fill('#settings-all-model', 'claude-haiku-4-5');
await page.click('#settings-all-apply');
await page.screenshot({ path: SHOT('2-applied-all') });
for (let i = 0; i < rowCount; i++) {
  const row = page.locator('#settings-agents .settings-agent-row').nth(i);
  const route = await row.locator('.sa-route').inputValue();
  const model = await row.locator('.sa-model').inputValue();
  if (route !== 'anthropic-api' || model !== 'claude-haiku-4-5') fail(`row ${i} not filled: ${route}/${model}`);
}

// Individual tweak after the fill must survive Save (the point of the design).
const firstModel = page.locator('#settings-agents .settings-agent-row').first().locator('.sa-model');
await firstModel.fill('claude-opus-4-8');

await page.click('#settings-save');
await page.waitForTimeout(700);

const saved = await (await fetch(BASE + '/api/settings/agent-routing')).json();
const ids = Object.keys(saved.routing);
if (ids.length !== 8) fail(`expected 8 routed agents persisted, got ${ids.length}: ${ids}`);
for (const [id, cfg] of Object.entries(saved.routing)) {
  if (cfg.route !== 'anthropic-api') fail(`${id} route persisted wrong: ${cfg.route}`);
}
const tweaked = saved.routing[saved.agents[0].id];
if (tweaked.model !== 'claude-opus-4-8') fail(`individual tweak lost: ${JSON.stringify(tweaked)}`);
const rest = Object.entries(saved.routing).filter(([id]) => id !== saved.agents[0].id);
if (!rest.every(([, c]) => c.model === 'claude-haiku-4-5')) fail('bulk model not persisted on remaining agents');
console.log('persisted all-8 routing with individual tweak: OK');

// Clear-all roundtrip back to defaults.
await page.click('#settings-btn');
await page.waitForSelector('#settings-all-apply', { timeout: 10000 });
await page.selectOption('#settings-all-route', '');
await page.fill('#settings-all-model', '');
await page.click('#settings-all-apply');
await page.screenshot({ path: SHOT('3-cleared-all') });
await page.click('#settings-save');
await page.waitForTimeout(700);

const cleared = await (await fetch(BASE + '/api/settings/agent-routing')).json();
if (Object.keys(cleared.routing).length !== 0) fail(`expected empty routing after clear, got ${JSON.stringify(cleared.routing)}`);
console.log('clear-all roundtrip: OK');

await browser.close();
console.log('E2E-PASS');
