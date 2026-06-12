/**
 * HLB-337 — per-session dollar cost must show in history, in the live panel, and
 * on reopen; and the cost-model settings (subscription / electricity) must
 * persist. Driven against a live server with an isolated temp DB. No LLM calls.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ART = (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'tmp', 'hlb-337-shots')) || '/tmp/hlb-337-shots';
mkdirSync(ART, { recursive: true });

function seedSession(dbPath, { sessionId, problem, totalTokens, breakdown, totalCostUsd, costBreakdown, msgCount = 0 }) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, total_tokens, token_breakdown, total_cost_usd, cost_breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, problem, 1, 0, now, now, totalTokens, breakdown ? JSON.stringify(breakdown) : null, totalCostUsd, costBreakdown ? JSON.stringify(costBreakdown) : null);
    const insertMsg = db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < msgCount; i++) insertMsg.run(randomUUID(), sessionId, `a${i}`, `Agent ${i}`, '🤖', '#0f0', `m${i}`, 'Analysis', now + i);
  } finally { db.close(); }
}

const dollars = (text) => { const m = (text || '').match(/\$([\d.,]+)/); return m ? Number(m[1].replace(/,/g, '')) : null; };

async function waitForWs(page) {
  await page.evaluate(() => { window.__wsReconnectDelayMs = 300; });
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
}

test.describe('HLB-337 per-session cost display + cost settings', () => {
  let server;
  test.beforeAll(async () => { server = await spawnServer(); });
  test.afterAll(async () => { if (server) await server.dispose(); });

  test('history card and reopen show the dollar cost; live tick updates it', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const sid = randomUUID();
    seedSession(server.dbPath, {
      sessionId: sid, problem: 'HLB-337 cost card', msgCount: 2,
      totalTokens: 480000,
      breakdown: { agent_turn: { input_tokens: 300000, output_tokens: 120000, total_tokens: 420000 }, tool_call: { input_tokens: 40000, output_tokens: 20000, total_tokens: 60000 }, quality: {}, memory: {}, embedding: {}, meta: {} },
      totalCostUsd: 4.56,
      costBreakdown: { 'anthropic-api': 4.56 },
    });

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForWs(page);

    // History card shows the dollar figure.
    await expect(page.locator(`.session-card[data-sid="${sid}"]`)).toBeVisible({ timeout: 8000 });
    const cardCost = await page.locator(`.session-card[data-sid="${sid}"] .sc-cost`).textContent();
    expect(dollars(cardCost)).toBe(4.56);
    await page.screenshot({ path: path.join(ART, 'cost-history.png'), fullPage: false });

    // Reopen -> the live panel shows the persisted cost.
    await page.evaluate((s) => ws.send(JSON.stringify({ type: 'join-session', sessionId: s })), sid);
    await expect(page.locator('#feed .message')).toHaveCount(2, { timeout: 8000 });
    await page.evaluate(() => document.getElementById('desktop-right').classList.add('open'));
    expect(dollars(await page.locator('#info-cost').textContent())).toBe(4.56);

    // A live token-tick carrying cost updates the panel on the fly.
    await page.evaluate((s) => handleMessage({ type: 'token-tick', sessionId: s, totalTokens: 500000, breakdown: { agent_turn: { total_tokens: 500000 } }, totalCostUsd: 7.89, costBreakdown: { 'anthropic-api': 7.89 } }), sid);
    await page.waitForTimeout(50);
    expect(dollars(await page.locator('#info-cost').textContent())).toBe(7.89);

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });

  test('cost-model settings load defaults, persist, and reflect on reopen', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForWs(page);

    await page.click('#settings-btn');
    await expect(page.locator('#settings-overlay')).toBeVisible();
    // Defaults are populated from /api/settings/cost.
    await expect(page.locator('#cost-plan-price')).toHaveValue('200');
    await expect(page.locator('#cost-kwh')).toHaveValue('0.3');

    // Change the plan price and electricity, save.
    await page.fill('#cost-plan-price', '120');
    await page.fill('#cost-kwh', '0.42');
    await page.screenshot({ path: path.join(ART, 'cost-settings.png'), fullPage: false });
    await page.click('#settings-save');
    await expect(page.locator('#settings-overlay')).toBeHidden();

    // Server persisted it.
    const cfg = await page.evaluate(async () => fetch('/api/settings/cost').then((r) => r.json()));
    expect(cfg.subscription.planPriceUsd).toBe(120);
    expect(cfg.electricity.pricePerKwh).toBe(0.42);

    // Reopen -> inputs show the saved values.
    await page.click('#settings-btn');
    await expect(page.locator('#cost-plan-price')).toHaveValue('120');
    await expect(page.locator('#cost-kwh')).toHaveValue('0.42');

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });
});
