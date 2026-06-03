/**
 * HLB-148 — the server must send each pending escalation's deadline to the
 * client so the inline card / queue can render a countdown (R1), and accept the
 * `escalation-timer` pause/reset ops over the WS (R2/R4).
 *
 * Two seams are checked end-to-end against a live server (isolated temp DB via
 * spawnServer):
 *   1. A pending escalation seeded directly into the DB surfaces over the genuine
 *      join-session → session-state path WITH a numeric `deadlineAt` and a
 *      `paused` boolean (R1: getSessionEscalations decoration).
 *   2. The `escalation-timer` WS op validates and round-trips a pause: the server
 *      broadcasts the updated timing (paused=true) back to subscribers (R2/R4).
 *
 * Plus a pure validation check that the new message type is accepted by the zod
 * gate (it is unreachable otherwise — every WS type must have a schema entry).
 *
 * Red phase: loadSession emits no deadlineAt/paused, validateWS rejects
 * `escalation-timer` as unknown, and ws-handler has no case for it, so every
 * assertion fails clearly.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnServer, delay } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateWS } = require(path.join(root, 'lib', 'validation.js'));

let server;

before(async () => {
  server = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
});
after(async () => {
  await server?.dispose();
});

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (data) => { try { inbox.push(JSON.parse(data.toString())); } catch {} });
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}
function send(ws, obj) {
  return new Promise((resolve, reject) => ws.send(JSON.stringify(obj), (e) => (e ? reject(e) : resolve())));
}

// Seed an ACTIVE session with one PENDING blocking escalation, the same rows a
// live deliberation persists. Active + pending so the server treats the
// escalation's deadline as live.
function seedPendingEscalation(dbPath, sessionId, escId) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)')
      .run(sessionId, 'HLB-148 deadline broadcast test', now, now);
    db.prepare(
      "INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, 'blocking', ?, NULL, 'pending', ?, NULL)",
    ).run(escId, sessionId, 'process-architect', 'Process Architect', '⚑', 'Q — [A] x / [B] y — default: A', 'assume A', now);
  } finally {
    db.close();
  }
}

// Seed an INACTIVE session (active=0) with a still-pending escalation aged past
// the default window — the crash-recovered / closed-session shape. No live waiter
// will ever park for it, so the server must NOT fabricate a (past) deadline.
function seedInactivePendingEscalation(dbPath, sessionId, escId) {
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    const old = now - 60 * 60 * 1000; // an hour ago — well past any 5-min window
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)')
      .run(sessionId, 'HLB-148 inactive escalation', old, old);
    db.prepare(
      "INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, 'blocking', ?, NULL, 'pending', ?, NULL)",
    ).run(escId, sessionId, 'process-architect', 'Process Architect', '⚑', 'Stale Q — [A] x / [B] y', 'assume A', old);
  } finally {
    db.close();
  }
}

describe('HLB-148 — deadline on the wire + escalation-timer op', () => {
  test('validateWS accepts escalation-timer pause/resume/reset and rejects junk ops', () => {
    const pause = validateWS({ type: 'escalation-timer', sessionId: 's', escalationId: 'e', op: 'pause' });
    assert.equal(pause.ok, true, 'pause op must validate');
    assert.equal(pause.data.op, 'pause');
    const resume = validateWS({ type: 'escalation-timer', sessionId: 's', escalationId: 'e', op: 'resume' });
    assert.equal(resume.ok, true, 'resume op must validate');
    assert.equal(resume.data.op, 'resume');
    const reset = validateWS({ type: 'escalation-timer', sessionId: 's', escalationId: 'e', op: 'reset' });
    assert.equal(reset.ok, true, 'reset op must validate');
    assert.equal(validateWS({ type: 'escalation-timer', sessionId: 's', escalationId: 'e', op: 'frobnicate' }).ok, false);
    assert.equal(validateWS({ type: 'escalation-timer', sessionId: 's', escalationId: 'e' }).ok, false);
  });

  test('join-session surfaces deadlineAt + paused on a pending escalation', async () => {
    const sessionId = randomUUID();
    const escId = randomUUID();
    seedPendingEscalation(server.dbPath, sessionId, escId);

    const a = await openWs(server.wsUrl);
    await delay(150);
    a.inbox.length = 0;
    await send(a.ws, { type: 'join-session', sessionId });
    await delay(300);

    const state = a.inbox.find((m) => m.type === 'session-state' && m.session && m.session.id === sessionId);
    assert.ok(state, `expected a session-state for ${sessionId}; inbox types: ${a.inbox.map((m) => m.type).join(',')}`);
    const esc = (state.session.escalations || []).find((e) => e.id === escId);
    assert.ok(esc, 'the pending escalation must be present in session-state');
    assert.equal(typeof esc.deadlineAt, 'number', 'pending escalation must carry a numeric deadlineAt');
    assert.ok(esc.deadlineAt > Date.now(), 'deadlineAt must be in the future for a fresh pending escalation');
    assert.equal(esc.paused, false, 'a fresh pending escalation is not paused');

    a.ws.close();
  });

  test('an INACTIVE session pending escalation carries deadlineAt=null (no fabricated past deadline)', async () => {
    // FIX 2: with no live waiter AND the session inactive, nothing will
    // auto-resolve, so the server must send deadlineAt:null rather than a
    // created_at + window timestamp that is already in the past (which the UI
    // would render as a false 0:00). The active path above still gets a number.
    const sessionId = randomUUID();
    const escId = randomUUID();
    seedInactivePendingEscalation(server.dbPath, sessionId, escId);

    const a = await openWs(server.wsUrl);
    await delay(150);
    a.inbox.length = 0;
    await send(a.ws, { type: 'join-session', sessionId });
    await delay(300);

    const state = a.inbox.find((m) => m.type === 'session-state' && m.session && m.session.id === sessionId);
    assert.ok(state, `expected a session-state for ${sessionId}; inbox types: ${a.inbox.map((m) => m.type).join(',')}`);
    const esc = (state.session.escalations || []).find((e) => e.id === escId);
    assert.ok(esc, 'the pending escalation must be present in session-state');
    assert.equal(esc.deadlineAt, null, 'an inactive-session escalation must NOT carry a fabricated deadline');
    assert.equal(esc.paused, false, 'paused is false in the neutral state');

    a.ws.close();
  });

  test('escalation-timer pause broadcasts updated timing (paused=true)', async () => {
    const sessionId = randomUUID();
    const escId = randomUUID();
    seedPendingEscalation(server.dbPath, sessionId, escId);

    const a = await openWs(server.wsUrl);
    await delay(150);
    // join to load the session into activeSessions + subscribe
    await send(a.ws, { type: 'join-session', sessionId });
    await delay(200);
    a.inbox.length = 0;

    await send(a.ws, { type: 'escalation-timer', sessionId, escalationId: escId, op: 'pause' });
    await delay(300);

    const upd = a.inbox.find((m) => m.type === 'escalation-timer-updated' && m.escalationId === escId);
    assert.ok(upd, `expected escalation-timer-updated; inbox types: ${a.inbox.map((m) => m.type).join(',')}`);
    assert.equal(upd.paused, true, 'pause op must broadcast paused=true');

    // reset must flip paused back to false and push the deadline out
    a.inbox.length = 0;
    await send(a.ws, { type: 'escalation-timer', sessionId, escalationId: escId, op: 'reset' });
    await delay(300);
    const updReset = a.inbox.find((m) => m.type === 'escalation-timer-updated' && m.escalationId === escId);
    assert.ok(updReset, 'reset must also broadcast an update');
    assert.equal(updReset.paused, false, 'reset op must broadcast paused=false');
    assert.equal(typeof updReset.deadlineAt, 'number', 'reset must include a fresh deadlineAt');

    a.ws.close();
  });
});
