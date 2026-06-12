/**
 * HLB-151 — the WS client must re-subscribe to the active session after a
 * socket drop so the live feed resumes without the user reopening the session,
 * and a message that lands during the gap must appear exactly once (no
 * duplicate row) once the connection is restored.
 *
 * This drives the REAL path end-to-end against a live server (isolated temp DB
 * via spawnServer). An ACTIVE session with a short transcript is seeded straight
 * into the server's SQLite file (the same rows a running deliberation persists),
 * loaded over the genuine `join-session` -> `session-state` WebSocket path. Then:
 *
 *   1. a new "gap" message row is written directly to the DB — this simulates a
 *      message the server persisted while the client's socket was dead/half-open,
 *      so no broadcast ever reached the live socket (the exact freeze condition);
 *   2. the page-side socket is force-closed (ws.close()), which on the current
 *      code schedules a fresh connect() whose new socket has an empty
 *      subscribedSessions set and never re-joins — so the gap message is lost and
 *      the feed freezes until the user manually reopens the session.
 *
 * After the fix, ws.onopen re-sends join-session for currentSession, the server
 * replies with the authoritative session-state (now including the gap message),
 * and the feed advances on its own. The dedup test then injects a late live
 * `message` carrying an id the rebuild already drew and asserts the row is not
 * duplicated.
 *
 * The 5000ms production reconnect backoff is shortened for the test via the
 * window.__wsReconnectDelayMs seam (production keeps the 5s default); this keeps
 * the spec deterministic rather than sleeping past a hardcoded timer.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR =
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'orchestrate', 'HLB-151')) ||
  '/home/peyman/.claude/jobs/41e0832c/orchestrate/HLB-151';
mkdirSync(ARTIFACT_DIR, { recursive: true });

// Seed an ACTIVE session row plus N agent messages directly into the server's
// DB file. Seeding the row (rather than POST /api/sessions) keeps it out of the
// in-memory activeSessions map, so join-session falls through to loadSession()
// and replies with the genuine persisted session-state.
function seedActiveSession(dbPath, sessionId, problem, count) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
      .run(sessionId, problem, 1, now, now);
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < count; i++) {
      insertMsg.run(
        randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖', '#00ff41',
        `Seed transcript message ${i + 1} with enough body to give the feed real height.`,
        'Analysis', now + i,
      );
    }
  } finally {
    db.close();
  }
}

// Insert a single message that the test treats as "arrived during the gap":
// it is persisted to the DB but never broadcast to the live socket. Returns the
// row id so the dedup test can replay it as a late live `message`.
function insertGapMessage(dbPath, sessionId, content) {
  const db = new Database(dbPath);
  const id = randomUUID();
  try {
    db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, sessionId, 'gap-agent', 'Gap Agent', '🛰️', '#ff00aa', content, 'Analysis', Date.now() + 1000);
  } finally {
    db.close();
  }
  return id;
}

// Seed a COMPLETED session (tall transcript + a process-architect Synthesis
// message) so the page mounts the sticky Decision Record card over a scrollable
// feed — the surface for the drDismissed + scroll regression checks.
function seedCompletedSession(dbPath, sessionId, problem) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(sessionId, problem, 6, now, now);
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 14; i++) {
      insertMsg.run(
        randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖', '#00ff41',
        `Transcript message ${i + 1} with enough body text to give the scroll container real height to work with across a reconnect rebuild.`,
        'Analysis', now + i,
      );
    }
    insertMsg.run(
      randomUUID(), sessionId, 'process-architect', 'Process Architect', '⚑', '#00ff41',
      '## DECISION\nShip the reconnect re-subscribe.\n\n## RATIONALE\nThe feed must not freeze on a socket drop.',
      'Synthesis', now + 100,
    );
  } finally {
    db.close();
  }
}

async function openSession(page, baseUrl, sessionId) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  // Shorten the reconnect backoff before any drop happens.
  await page.evaluate(() => { window.__wsReconnectDelayMs = 300; });
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
  await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), sessionId);
  // Wait until the seeded transcript has rendered.
  await expect(page.locator('#feed .message')).toHaveCount(3, { timeout: 8000 });
}

test.describe('HLB-151 WS reconnect re-subscribe', () => {
  let server;
  const consoleErrors = [];

  test.beforeAll(async () => {
    server = await spawnServer();
  });

  test.afterAll(async () => {
    if (server) await server.dispose();
  });

  test('feed resumes after a socket drop without the user reopening the session', async ({ page }) => {
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const sessionId = randomUUID();
    seedActiveSession(server.dbPath, sessionId, 'HLB-151 e2e: reconnect resume', 3);

    await openSession(page, server.baseUrl, sessionId);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'before-drop.png'), fullPage: false });

    // A message lands while the socket is (about to be) dead: persisted, not broadcast.
    const GAP = 'gap-message-only-visible-after-resubscribe';
    insertGapMessage(server.dbPath, sessionId, GAP);

    // Capture the socket identity so we can prove the reconnect produced a NEW one.
    await page.evaluate(() => { window.__wsBefore = ws; });

    // Force the drop. onclose schedules connect() after the (shortened) backoff.
    await page.evaluate(() => ws.close());

    // Wait for a brand-new live socket (proves the reconnect actually happened).
    await page.waitForFunction(
      () => typeof ws !== 'undefined' && ws && ws.readyState === 1 && ws !== window.__wsBefore,
      null,
      { timeout: 8000 },
    );

    // The feed must advance to include the gap message WITHOUT the user reopening
    // the session. On current code the new socket never re-subscribes, so the gap
    // message never arrives and this times out.
    const gapRow = page.locator('#feed .message', { hasText: GAP });
    await expect(gapRow).toHaveCount(1, { timeout: 8000 });

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-reconnect.png'), fullPage: false });
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('a live message already drawn by the reconnect rebuild is not duplicated', async ({ page }) => {
    const sessionId = randomUUID();
    seedActiveSession(server.dbPath, sessionId, 'HLB-151 e2e: reconnect dedup', 3);

    await openSession(page, server.baseUrl, sessionId);

    const GAP = 'gap-message-for-dedup-check';
    const gapId = insertGapMessage(server.dbPath, sessionId, GAP);

    await page.evaluate(() => { window.__wsBefore = ws; });
    await page.evaluate(() => ws.close());
    await page.waitForFunction(
      () => typeof ws !== 'undefined' && ws && ws.readyState === 1 && ws !== window.__wsBefore,
      null,
      { timeout: 8000 },
    );

    // After reconnect the rebuild has drawn the gap message exactly once.
    await expect(page.locator('#feed .message', { hasText: GAP })).toHaveCount(1, { timeout: 8000 });

    // Now replay a late live broadcast for the SAME persisted row (the race the
    // server can produce: a `message` whose id was already in the session-state
    // snapshot). The dedup guard must drop it; without the guard addMessage()
    // appends a second identical row.
    await page.evaluate(({ id, content }) => {
      handleMessage({
        type: 'message',
        id,
        sessionId: (typeof currentSession !== 'undefined' && currentSession && currentSession.id) || undefined,
        agentId: 'gap-agent',
        agentName: 'Gap Agent',
        agentEmoji: '🛰️',
        agentColor: '#ff00aa',
        content,
        phase: 'Analysis',
        timestamp: Date.now() + 2000,
      });
    }, { id: gapId, content: GAP });

    // Still exactly one row carrying the gap content.
    await expect(page.locator('#feed .message', { hasText: GAP })).toHaveCount(1, { timeout: 4000 });
  });

  test('reconnect rebuild keeps a dismissed Decision Record dismissed and preserves scroll', async ({ page }) => {
    const sessionId = randomUUID();
    seedCompletedSession(server.dbPath, sessionId, 'HLB-151 e2e: reconnect regression guards');

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__wsReconnectDelayMs = 300; });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), sessionId);

    // The sticky Decision Record card mounts via the genuine session-state path.
    const card = page.locator('#decision-record');
    await expect(card).toBeVisible({ timeout: 8000 });

    // User dismisses it (HLB-140), then scrolls the transcript away from bottom.
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('#decision-record')).toHaveCount(0);

    const scrollBefore = await page.evaluate(() => {
      const f = document.getElementById('feed');
      f.style.scrollBehavior = 'auto';
      f.scrollTop = Math.max(0, Math.round(f.scrollHeight / 3));
      return f.scrollTop;
    });
    expect(scrollBefore, 'feed must be scrollable for the scroll-preservation check to be real').toBeGreaterThan(0);

    // Force a drop + reconnect. The new socket re-joins and the server replies
    // session-state, rebuilding the feed.
    await page.evaluate(() => { window.__wsBefore = ws; });
    await page.evaluate(() => ws.close());
    await page.waitForFunction(
      () => typeof ws !== 'undefined' && ws && ws.readyState === 1 && ws !== window.__wsBefore,
      null,
      { timeout: 8000 },
    );

    // Let the rebuild settle (feed re-rendered from the authoritative payload:
    // 14 transcript rows + the Synthesis row the Decision Record templates from).
    await expect(page.locator('#feed .message')).toHaveCount(15, { timeout: 8000 });

    // Guard 1 (HLB-140): the reconnect rebuild must NOT resurrect the dismissed card.
    await expect(page.locator('#decision-record')).toHaveCount(0);

    // Guard 2: the user's scroll offset survives the rebuild (no jump to top/bottom).
    const scrollAfter = await page.evaluate(() => document.getElementById('feed').scrollTop);
    expect(Math.abs(scrollAfter - scrollBefore), `scroll jumped ${scrollBefore} -> ${scrollAfter}`).toBeLessThanOrEqual(4);
  });
});
