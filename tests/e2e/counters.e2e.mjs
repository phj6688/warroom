/**
 * HLB-149 — the session counters must reflect the real message and escalation
 * totals, live and on reopen, and must NOT silently reset to zero mid-session.
 *
 * Four elements track the same two numbers: the right-panel `#info-messages` /
 * `#info-escalations` and the phase-bar `#bar-msgs` / `#bar-esc`. They are wired
 * to `messageCount` / `escalationCount`, set on the `message` / `escalation`
 * handlers and rebuilt on `session-state`.
 *
 * The defect this spec pins: the server re-broadcasts a `phases` event on every
 * WebSocket (re)connection (lib/ws-handler.js connection handler). On the client
 * that runs renderPhaseBar(), which re-creates the `#bar-msgs` / `#bar-esc` nodes
 * with hard-coded "0 msgs" / "0 escalations" text and never re-applies the live
 * counts. So mid-session the phase-bar stats drop to zero while the right panel
 * still reads the real totals — the counters disagree and the bar is wrong.
 *
 * The run is driven end-to-end against a live server with an isolated temp DB
 * (spawnServer). A session with a known transcript and a known number of
 * escalations is seeded straight into SQLite, then loaded over the genuine
 * `join-session` -> `session-state` path. No LLM calls.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR =
  (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'orchestrate', 'HLB-149')) ||
  '/tmp/orchestrate/HLB-149';
mkdirSync(ARTIFACT_DIR, { recursive: true });

// Seed a session row plus N agent messages and M escalations directly into the
// server's DB file. Seeding the row (rather than POST /api/sessions) keeps it
// out of the in-memory activeSessions map, so join-session falls through to
// loadSession() and replies with the genuine persisted session-state — the same
// payload a real reopen produces.
function seedSession(dbPath, sessionId, problem, msgCount, escCount, active = true) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, problem, 1, active ? 1 : 0, now, now);
    const insertMsg = db.prepare(
      'INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < msgCount; i++) {
      insertMsg.run(
        randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖', '#00ff41',
        `Seed transcript message ${i + 1} with enough body to give the feed real height.`,
        'Analysis', now + i,
      );
    }
    const insertEsc = db.prepare(
      "INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, NULL)",
    );
    for (let i = 0; i < escCount; i++) {
      insertEsc.run(
        randomUUID(), sessionId, `agent-${i}`, `Agent ${i + 1}`, '🤖',
        `Escalation question ${i + 1}? Needs a human decision.`, 'blocking', null, now + 100 + i,
      );
    }
  } finally {
    db.close();
  }
}

// Read all four counter elements at once. Numbers are parsed out of the text so
// the assertions don't depend on the exact suffix ("5 msgs" vs "5").
async function readCounters(page) {
  return page.evaluate(() => {
    const num = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const m = (el.textContent || '').match(/\d+/);
      return m ? Number(m[0]) : null;
    };
    return {
      infoMsg: num('info-messages'),
      infoEsc: num('info-escalations'),
      barMsg: num('bar-msgs'),
      barEsc: num('bar-esc'),
    };
  });
}

async function openSession(page, baseUrl, sessionId, expectedMsgRows) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__wsReconnectDelayMs = 300; });
  await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
  await page.evaluate((sid) => ws.send(JSON.stringify({ type: 'join-session', sessionId: sid })), sessionId);
  await expect(page.locator('#feed .message')).toHaveCount(expectedMsgRows, { timeout: 8000 });
}

test.describe('HLB-149 session counters reflect real totals', () => {
  let server;

  test.beforeAll(async () => {
    server = await spawnServer();
  });

  test.afterAll(async () => {
    if (server) await server.dispose();
  });

  test('all four counters match real totals on open, on live events, and across a phases re-broadcast', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

    const sessionId = randomUUID();
    const MSGS = 5;
    const ESCS = 2;
    seedSession(server.dbPath, sessionId, 'HLB-149 e2e: counters reflect totals', MSGS, ESCS);

    await openSession(page, server.baseUrl, sessionId, MSGS);
    await page.waitForTimeout(200);

    // R1/R2/R3 — on first render all four show the stored totals.
    expect(await readCounters(page)).toEqual({ infoMsg: MSGS, infoEsc: ESCS, barMsg: MSGS, barEsc: ESCS });

    // A live message and a live escalation arrive — every counter advances by one.
    await page.evaluate((sid) => {
      handleMessage({
        type: 'message', id: 'live-msg-1', sessionId: sid, agentId: 'agent-live', agentName: 'Live Agent',
        agentEmoji: '🤖', agentColor: '#00ff41', content: 'a live broadcast message', phase: 'Analysis', timestamp: Date.now(),
      });
      handleMessage({
        type: 'escalation', id: 'live-esc-1', sessionId: sid, agentId: 'agent-live', agentName: 'Live Agent',
        question: 'a live escalation?', severity: 'blocking',
      });
    }, sessionId);
    await page.waitForTimeout(100);
    expect(await readCounters(page)).toEqual({ infoMsg: MSGS + 1, infoEsc: ESCS + 1, barMsg: MSGS + 1, barEsc: ESCS + 1 });

    // THE BUG: the server re-broadcasts `phases` on every (re)connection. That
    // re-renders the phase bar. Before the fix this wipes #bar-msgs / #bar-esc
    // back to "0 msgs" / "0 escalations" while the right panel keeps the real
    // totals, so the two surfaces disagree. After the fix the bar keeps the live
    // counts.
    await page.evaluate(() => handleMessage({
      type: 'phases',
      phases: [{ name: 'Framing' }, { name: 'Analysis' }, { name: 'Divergence' }, { name: 'Convergence' }, { name: 'Synthesis' }],
    }));
    await page.waitForTimeout(100);
    expect(await readCounters(page), 'phase-bar stats must survive a phases re-broadcast')
      .toEqual({ infoMsg: MSGS + 1, infoEsc: ESCS + 1, barMsg: MSGS + 1, barEsc: ESCS + 1 });

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('counters reflect real totals after reopening the session at 1280px and 375px', async ({ page }) => {
    const sessionId = randomUUID();
    const MSGS = 7;
    const ESCS = 3;
    seedSession(server.dbPath, sessionId, 'HLB-149 e2e: reopen breakpoints', MSGS, ESCS, false);

    // ── 1280px (desktop): right panel + phase bar both visible ──
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(page, server.baseUrl, sessionId, MSGS);
    await page.waitForTimeout(200);
    // Re-broadcast phases AFTER the reopen to prove the counts are not clobbered
    // by the very event that fires on every reconnect.
    await page.evaluate(() => handleMessage({
      type: 'phases',
      phases: [{ name: 'Framing' }, { name: 'Analysis' }, { name: 'Divergence' }, { name: 'Convergence' }, { name: 'Synthesis' }],
    }));
    await page.waitForTimeout(100);
    expect(await readCounters(page), '1280px reopen totals')
      .toEqual({ infoMsg: MSGS, infoEsc: ESCS, barMsg: MSGS, barEsc: ESCS });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-1280.png'), fullPage: false });

    // ── 375px (mobile): phase bar is the visible counter surface ──
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(150);
    expect(await readCounters(page), '375px reopen totals')
      .toEqual({ infoMsg: MSGS, infoEsc: ESCS, barMsg: MSGS, barEsc: ESCS });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-375.png'), fullPage: false });

    // ── 768px (tablet) ──
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(150);
    expect(await readCounters(page), '768px reopen totals')
      .toEqual({ infoMsg: MSGS, infoEsc: ESCS, barMsg: MSGS, barEsc: ESCS });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'after-768.png'), fullPage: false });
  });
});
