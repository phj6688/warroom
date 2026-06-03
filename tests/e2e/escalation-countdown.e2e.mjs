/**
 * HLB-148 — a pending human escalation card must show a live countdown the user
 * can pause and reset, so they control how long the agents wait instead of
 * racing a hidden 5-minute deadline.
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
 * Asserts: the inline countdown + queue chip render and tick down (textContent
 * only), the Pause and Reset buttons exist with 44pt touch targets, Pause flips
 * the card to a paused state via a real escalation-timer WS round-trip, Reset
 * restores the countdown, and the whole flow fires no console errors.
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

// Seed an ACTIVE session with one PENDING blocking escalation — the rows a live
// deliberation persists mid-flight. Active + pending so the server treats the
// deadline as live and surfaces deadlineAt over join-session. Seeding the row
// directly keeps it out of activeSessions, so the WS join-session handler falls
// through to loadSession() and replies with the genuine decorated state.
function seedPendingEscalation(dbPath, sessionId, escId) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)')
      .run(sessionId, 'HLB-148 e2e: pausable escalation countdown', now, now);
    db.prepare(
      "INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, 'blocking', ?, NULL, 'pending', ?, NULL)",
    ).run(escId, sessionId, 'process-architect', 'Process Architect', '⚑', QUESTION, 'ship v1 now', now);
  } finally {
    db.close();
  }
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

    // BEFORE: the card with a running countdown + Pause/Reset controls.
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'before-countdown-running.png'), fullPage: false });

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

    // AFTER: the paused card (Resume button + Paused chip).
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-paused.png'), fullPage: false });

    // Reset resumes the countdown (back to a ticking m:ss, button back to Pause).
    await resetBtn.click();
    await expect(pauseBtn).toHaveText(/Pause/, { timeout: 4000 });
    await expect(countdown).toHaveText(/\d+:\d{2}/, { timeout: 4000 });
    await expect(card).not.toHaveClass(/esc-paused/);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-reset-resumed.png'), fullPage: false });

    // No console errors fired through the whole flow.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
