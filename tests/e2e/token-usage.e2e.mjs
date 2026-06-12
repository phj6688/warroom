/**
 * HLB-335 — per-session token usage must be visible: a grand total on every
 * history card, a live counter that ticks up during a session, and a per-
 * category breakdown when a completed session is reopened.
 *
 * Driven end-to-end against a live server with an isolated temp DB (spawnServer).
 * Sessions are seeded straight into SQLite (token totals + breakdown JSON) and
 * loaded over the genuine join-session -> session-state path, so this also
 * exercises the ws-handler change that puts the token fields on that payload.
 * The live counter is driven through the real `token-tick` handler. No LLM calls.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR =
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'tmp', 'hlb-335-shots')) ||
  '/tmp/hlb-335-shots';
mkdirSync(ARTIFACT_DIR, { recursive: true });

const CATS = ['agent_turn', 'tool_call', 'quality', 'memory', 'embedding', 'meta'];

// Build a token_breakdown JSON whose category totals sum to `total`, matching
// the shape lib/token-usage.js snapshot() persists.
function makeBreakdown(perCat) {
  const bd = {};
  let total = 0;
  for (const c of CATS) {
    const t = perCat[c] || 0;
    const input = Math.round(t * 0.6);
    bd[c] = { input_tokens: input, output_tokens: t - input, total_tokens: t, calls: t ? 1 : 0, estimated: 0 };
    total += t;
  }
  return { breakdown: bd, total };
}

// Seed a session row (optionally with token total + breakdown) plus N messages.
function seedSession(dbPath, { sessionId, problem, msgCount = 0, active = true, totalTokens = null, breakdown = null }) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, total_tokens, token_breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, problem, 1, active ? 1 : 0, now, now, totalTokens, breakdown ? JSON.stringify(breakdown) : null);
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < msgCount; i++) {
      insertMsg.run(randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖', '#00ff41',
        `Seed transcript message ${i + 1}.`, 'Analysis', now + i);
    }
  } finally {
    db.close();
  }
}

// Parse an integer out of a rendered figure, tolerating thousands separators
// ("123,456 tok" -> 123456) and the em-dash placeholder ("— tok" -> null).
function parseNum(text) {
  const m = (text || '').match(/[\d,]+/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function waitForWs(page) {
  await page.evaluate(() => { window.__wsReconnectDelayMs = 300; });
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
}

// The right panel (#desktop-right, which holds #info-tokens and the #dr-tokens
// breakdown) is a toggle: display:none until it has the `open` class. The phase
// bar #bar-tokens is the always-on live counter; open the panel when we want to
// assert/screenshot the breakdown surface.
async function openRightPanel(page) {
  await page.evaluate(() => document.getElementById('desktop-right').classList.add('open'));
}

test.describe('HLB-335 per-session token usage display', () => {
  let server;
  test.beforeAll(async () => { server = await spawnServer(); });
  test.afterAll(async () => { if (server) await server.dispose(); });

  test('R1: history cards show each session grand total (and a dash when absent)', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const withTok = randomUUID();
    const noTok = randomUUID();
    seedSession(server.dbPath, { sessionId: withTok, problem: 'HLB-335 card with tokens', active: false, totalTokens: 123456 });
    seedSession(server.dbPath, { sessionId: noTok, problem: 'HLB-335 card without tokens', active: false, totalTokens: null });

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForWs(page);
    await expect(page.locator(`.session-card[data-sid="${withTok}"]`)).toBeVisible({ timeout: 8000 });

    const tokText = await page.locator(`.session-card[data-sid="${withTok}"] .sc-tokens`).textContent();
    expect(parseNum(tokText), `card token figure: "${tokText}"`).toBe(123456);

    const noTokText = await page.locator(`.session-card[data-sid="${noTok}"] .sc-tokens`).textContent();
    expect(parseNum(noTokText), `absent token figure should be a dash: "${noTokText}"`).toBe(null);
    expect((noTokText || '').includes('tok')).toBe(true); // every card carries the field

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'r1-history-totals.png'), fullPage: false });
    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });

  test('R2: live token counter ticks up and survives a phases re-broadcast', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const sid = randomUUID();
    seedSession(server.dbPath, { sessionId: sid, problem: 'HLB-335 live counter', msgCount: 2, active: true });
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForWs(page);
    await page.evaluate((s) => ws.send(JSON.stringify({ type: 'join-session', sessionId: s })), sid);
    await expect(page.locator('#feed .message')).toHaveCount(2, { timeout: 8000 });
    await openRightPanel(page);

    // A fresh active session starts at zero (no persisted tokens yet).
    expect(await page.locator('#info-tokens').textContent()).toBe('0');

    // First live tick.
    const first = makeBreakdown({ agent_turn: 8000, tool_call: 1500, quality: 0, memory: 0, embedding: 500, meta: 0 });
    await page.evaluate(({ total, breakdown, s }) => handleMessage({ type: 'token-tick', sessionId: s, totalTokens: total, breakdown }), { ...first, s: sid });
    await page.waitForTimeout(50);
    expect(parseNum(await page.locator('#info-tokens').textContent())).toBe(first.total);
    expect(parseNum(await page.locator('#bar-tokens').textContent())).toBe(first.total);
    await expect(page.locator('#dr-tokens')).toBeVisible();
    expect(parseNum(await page.locator('#tok-cat-agent_turn').textContent())).toBe(8000);

    // Second tick is larger — the counter ticks UP, not resets.
    const second = makeBreakdown({ agent_turn: 20000, tool_call: 4000, quality: 3000, memory: 1200, embedding: 900, meta: 300 });
    await page.evaluate(({ total, breakdown, s }) => handleMessage({ type: 'token-tick', sessionId: s, totalTokens: total, breakdown }), { ...second, s: sid });
    await page.waitForTimeout(50);
    const ticked = parseNum(await page.locator('#info-tokens').textContent());
    expect(ticked).toBe(second.total);
    expect(ticked).toBeGreaterThan(first.total);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'r2-live-counter.png'), fullPage: false });

    // The server re-broadcasts `phases` on every reconnect; that re-renders the
    // phase bar. The token figure on the bar must not blank out (same class of
    // bug HLB-149 fixed for msg/esc counters).
    await page.evaluate(() => handleMessage({ type: 'phases', phases: [{ name: 'Framing' }, { name: 'Analysis' }, { name: 'Synthesis' }] }));
    await page.waitForTimeout(50);
    expect(parseNum(await page.locator('#bar-tokens').textContent()), 'bar token figure survives phases re-broadcast').toBe(second.total);

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });

  test('R4: reopening a completed session shows the per-category breakdown summing to the total', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    const sid = randomUUID();
    const { breakdown, total } = makeBreakdown({ agent_turn: 30000, tool_call: 6500, quality: 4500, memory: 2500, embedding: 1000, meta: 230 });
    seedSession(server.dbPath, { sessionId: sid, problem: 'HLB-335 reopen breakdown', msgCount: 3, active: false, totalTokens: total, breakdown });

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForWs(page);
    await page.evaluate((s) => ws.send(JSON.stringify({ type: 'join-session', sessionId: s })), sid);
    await expect(page.locator('#feed .message')).toHaveCount(3, { timeout: 8000 });
    await page.waitForTimeout(100);
    await openRightPanel(page);

    // session-state carried the persisted token fields -> total + breakdown render.
    await expect(page.locator('#dr-tokens')).toBeVisible();
    expect(parseNum(await page.locator('#info-tokens').textContent()), 'grand total on reopen').toBe(total);

    let sum = 0;
    for (const c of CATS) {
      const v = parseNum(await page.locator(`#tok-cat-${c}`).textContent());
      expect(v, `category ${c} rendered`).not.toBeNull();
      sum += v;
    }
    expect(sum, 'breakdown categories sum to the grand total').toBe(total);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'r4-breakdown.png'), fullPage: false });
    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });
});
