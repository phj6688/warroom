/**
 * HLB-148 — a pending human escalation card must show a live countdown the user
 * can pause, RESUME (continue from the time left), and reset (fresh full window),
 * so they control how long the agents wait instead of racing a hidden 5-minute
 * deadline.
 *
 * Drives the REAL path end-to-end against a live server (isolated temp DB via
 * spawnServer): an ACTIVE session carrying one PENDING blocking escalation is
 * seeded straight into the server's SQLite file (the same rows a live
 * deliberation persists), then loaded over the genuine join-session →
 * session-state WebSocket path. The server decorates the escalation with
 * deadlineAt + paused; the page's own handler mounts the card. No DOM is faked
 * and no page-side test hook is installed, so production index.html ships no
 * debug residue.
 *
 * Two specs:
 *   1. The countdown renders + ticks (textContent only) and Pause/Reset have
 *      44pt touch targets — the baseline UI contract.
 *   2. The resume-vs-reset distinction (the fix): an escalation seeded with an
 *      OLD created_at surfaces a REDUCED remaining window. Pausing freezes it;
 *      Resume CONTINUES from that reduced value (NOT a fresh 5:00); Reset hands
 *      back the full window. Screenshots prove each state.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ARTIFACT_DIR =
  (process.env.HLB148_ARTIFACT_DIR) ||
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'orchestrate', 'HLB-148')) ||
  path.join(os.tmpdir(), 'hlb-148-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

const QUESTION = 'Ship v1 now or wait for the audit? — [A] ship / [B] wait — default: A';
// The fallback window the server grants an active escalation with no live waiter.
const FULL_WINDOW_MS = 5 * 60 * 1000;

// Seed an ACTIVE session with one PENDING blocking escalation — the rows a live
// deliberation persists mid-flight. Active + pending so the server treats the
// deadline as live and surfaces deadlineAt over join-session. Seeding the row
// directly keeps it out of activeSessions, so the WS join-session handler falls
// through to loadSession() and replies with the genuine decorated state.
//
// `ageMs` backdates created_at so the active-session fallback deadline
// (created_at + full window) lands only (full window - ageMs) in the future —
// i.e. a REDUCED remaining time, the precondition for proving resume continues
// from less than a fresh window.
function seedPendingEscalation(dbPath, sessionId, escId, ageMs = 0) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    const created = now - ageMs;
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)')
      .run(sessionId, 'HLB-148 e2e: pausable escalation countdown', created, now);
    db.prepare(
      "INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, 'blocking', ?, NULL, 'pending', ?, NULL)",
    ).run(escId, sessionId, 'process-architect', 'Process Architect', '⚑', QUESTION, 'ship v1 now', created);
  } finally {
    db.close();
  }
}

// Parse a countdown chip's "⏳ M:SS" / "M:SS" text into whole seconds.
function parseMmSs(text) {
  const m = /(\d+):(\d{2})/.exec(text || '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

test.describe('HLB-148 escalation countdown + Pause/Reset', () => {
  let server;
  let sessionId;
  let escId;
  const consoleErrors = [];

  test.beforeAll(async () => {
    server = await spawnServer();
    sessionId = randomUUID();
    escId = randomUUID();
    seedPendingEscalation(server.dbPath, sessionId, escId);
  });

  test.afterAll(async () => {
    if (server) await server.dispose();
  });

  test('pending card shows a live countdown with working Pause/Reset', async ({ page }) => {
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), sessionId);

    // The inline escalation card mounts via the genuine session-state handler.
    const card = page.locator(`#esc-${escId}`);
    await expect(card).toBeVisible({ timeout: 8000 });

    // R3: a countdown element on the card, populated (not the placeholder dash).
    const countdown = page.locator(`#esc-timer-${escId}`);
    await expect(countdown).toBeVisible();
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });
    const first = (await countdown.textContent()).trim();

    // R3: it ticks DOWN once per second without re-rendering the card body. We
    // confirm the value changes and the card's identity (the input element) is
    // the SAME node across ticks (textContent-only update, no innerHTML rebuild).
    const inputHandleBefore = await card.locator('.esc-input').elementHandle();
    await page.waitForFunction(
      (args) => {
        const el = document.getElementById(`esc-timer-${args.id}`);
        return el && el.textContent.trim() !== args.first;
      },
      { id: escId, first },
      { timeout: 4000 },
    );
    const second = (await countdown.textContent()).trim();
    expect(second, `countdown should change (${first} -> ${second})`).not.toEqual(first);
    const inputHandleAfter = await card.locator('.esc-input').elementHandle();
    expect(
      await page.evaluate(([a, b]) => a === b, [inputHandleBefore, inputHandleAfter]),
      'the card body must NOT be re-rendered on each tick (same input node)',
    ).toBe(true);

    // R4: Pause and Reset buttons exist with 44pt touch targets.
    const pauseBtn = page.locator(`#esc-pause-${escId}`);
    const resetBtn = card.locator('.esc-reset');
    await expect(pauseBtn).toBeVisible();
    await expect(resetBtn).toBeVisible();
    for (const [name, btn] of [['pause', pauseBtn], ['reset', resetBtn]]) {
      const box = await btn.boundingBox();
      expect(box, `${name} must have a layout box`).not.toBeNull();
      expect(box.height, `${name} height ${box?.height} should be >= 44`).toBeGreaterThanOrEqual(44);
    }

    // R4: clicking Pause sends escalation-timer{op:pause}; the server replies with
    // escalation-timer-updated(paused=true) and the card reflects it.
    await pauseBtn.click();
    await expect(card).toHaveClass(/esc-paused/, { timeout: 4000 });
    await expect(pauseBtn).toHaveText(/Resume/);
    await expect(countdown).toHaveText(/Paused/);

    // While paused the countdown text must hold steady (no auto-tick-down).
    const pausedText = (await countdown.textContent()).trim();
    await page.waitForTimeout(1500);
    expect((await countdown.textContent()).trim(), 'paused countdown must not change').toEqual(pausedText);

    // Reset resumes the countdown (back to a ticking m:ss, button back to Pause).
    await resetBtn.click();
    await expect(pauseBtn).toHaveText(/Pause/, { timeout: 4000 });
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });
    await expect(card).not.toHaveClass(/esc-paused/);

    // No console errors fired through the whole flow.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  // The fix: Resume must CONTINUE from the time left at pause, not silently grant
  // a fresh full window (the old behavior sent op:'reset' on Resume). We seed an
  // escalation aged so only ~30s remains, prove Pause freezes that reduced value,
  // Resume keeps it reduced, and Reset jumps it back to the full 5:00.
  test('Resume continues from the REDUCED remaining time; Reset restores the full window', async ({ page }) => {
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    // ~30s remaining: created 4.5 min ago, full window 5 min → ~0:30 on the clock.
    const reducedSessionId = randomUUID();
    const reducedEscId = randomUUID();
    seedPendingEscalation(server.dbPath, reducedSessionId, reducedEscId, FULL_WINDOW_MS - 30_000);

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), reducedSessionId);

    const card = page.locator(`#esc-${reducedEscId}`);
    await expect(card).toBeVisible({ timeout: 8000 });
    const countdown = page.locator(`#esc-timer-${reducedEscId}`);
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });

    // The remaining time must be CLEARLY less than a fresh window — proving the
    // reduced precondition (a fresh 5:00 would read 4:5x / 5:00).
    const reducedSecs = parseMmSs(await countdown.textContent());
    expect(reducedSecs, `seeded escalation should show a reduced ~30s, got ${reducedSecs}s`).not.toBeNull();
    expect(reducedSecs, `remaining ${reducedSecs}s must be well under the full ${FULL_WINDOW_MS / 1000}s window`).toBeLessThan(120);

    // (a) PAUSE — freezes at the reduced value.
    const pauseBtn = page.locator(`#esc-pause-${reducedEscId}`);
    const resetBtn = card.locator('.esc-reset');
    await pauseBtn.click();
    await expect(card).toHaveClass(/esc-paused/, { timeout: 4000 });
    await expect(pauseBtn).toHaveText(/Resume/);
    await expect(countdown).toHaveText(/Paused/);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'fix-pause.png'), fullPage: false });

    // (b) RESUME — must CONTINUE from the reduced value, NOT jump to a fresh 5:00.
    await pauseBtn.click(); // paused -> Resume sends op:'resume'
    await expect(pauseBtn).toHaveText(/Pause/, { timeout: 4000 });
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });
    await expect(card).not.toHaveClass(/esc-paused/);
    const resumedSecs = parseMmSs(await countdown.textContent());
    expect(resumedSecs, `resumed countdown should be numeric, got "${await countdown.textContent()}"`).not.toBeNull();
    // The crux: resume stayed near the reduced value (a fresh window would be ~300s).
    expect(
      resumedSecs,
      `Resume must CONTINUE from ~${reducedSecs}s, not restart to a full window — got ${resumedSecs}s`,
    ).toBeLessThan(90);
    expect(
      resumedSecs,
      `Resume (${resumedSecs}s) must be far below a fresh ${FULL_WINDOW_MS / 1000}s window`,
    ).toBeLessThan(FULL_WINDOW_MS / 1000 - 120);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'fix-resume.png'), fullPage: false });

    // (c) RESET — the separate button restores the FULL window (fresh ~5:00).
    await resetBtn.click();
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });
    // Wait for the reset broadcast to push the value clearly above the reduced one.
    await page.waitForFunction(
      (id) => {
        const el = document.getElementById(`esc-timer-${id}`);
        const m = el && /(\d+):(\d{2})/.exec(el.textContent || '');
        return m && (Number(m[1]) * 60 + Number(m[2])) > 120;
      },
      reducedEscId,
      { timeout: 4000 },
    );
    const resetSecs = parseMmSs(await countdown.textContent());
    expect(
      resetSecs,
      `Reset must restore the full ~${FULL_WINDOW_MS / 1000}s window, got ${resetSecs}s`,
    ).toBeGreaterThan(FULL_WINDOW_MS / 1000 - 30);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'fix-reset.png'), fullPage: false });

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
