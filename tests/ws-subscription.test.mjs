/**
 * F2 — Per-client WebSocket subscription isolation.
 *
 * Spec: forge/hardening/TASKSPEC.md §F2
 *
 * Today every WS client receives every broadcast. After F2, broadcasts
 * tagged with a sessionId only reach clients that have subscribed to that
 * session via {type:'subscribe', sessionId}. Global broadcasts are an
 * explicit opt-in via broadcastGlobal().
 *
 * In red phase: there is no `subscribe` message type, so the server will
 * either ignore it or error. The current broadcast() floods every client
 * with every message — this test will fail because client A will see
 * client B's session message.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { spawnServer, delay } from './_helpers.mjs';

let server;

before(async () => {
  server = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
});

after(async () => {
  await server?.dispose();
});

// ─── Helpers (file-local) ────────────────────────────────────
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (data) => {
      try { inbox.push(JSON.parse(data.toString())); } catch { /* skip non-JSON */ }
    });
    ws.on('open', () => resolve({ ws, inbox }));
    ws.on('error', reject);
  });
}

function send(ws, obj) {
  return new Promise((resolve, reject) =>
    ws.send(JSON.stringify(obj), (err) => (err ? reject(err) : resolve()))
  );
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    try { ws.close(); } catch { resolve(); }
  });
}

async function createSession(baseUrl, problem) {
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ problem }),
  });
  if (!res.ok) throw new Error(`createSession failed ${res.status}`);
  return res.json();
}

// ─── Tests ───────────────────────────────────────────────────
describe('F2 WS — per-client subscription isolation', () => {
  test('client A subscribed to session X does not receive messages tagged session Y', async () => {
    const sessionX = await createSession(server.baseUrl, 'Problem X — for client A');
    const sessionY = await createSession(server.baseUrl, 'Problem Y — for client B');

    const a = await openWs(server.wsUrl);
    const b = await openWs(server.wsUrl);

    // Drain initial state messages (sessions/agents/phases handshake).
    await delay(150);
    a.inbox.length = 0;
    b.inbox.length = 0;

    await send(a.ws, { type: 'subscribe', sessionId: sessionX.id });
    await send(b.ws, { type: 'subscribe', sessionId: sessionY.id });
    await delay(50);

    // Trigger something tagged sessionX. The cleanest way without LLM
    // round-trips is a human-message which the server broadcasts immediately.
    await send(a.ws, {
      type: 'human-message',
      sessionId: sessionX.id,
      content: 'beacon-for-X-only',
    });

    // Give the server a moment to broadcast.
    await delay(300);

    const aSawX = a.inbox.some((m) => JSON.stringify(m).includes('beacon-for-X-only'));
    const bSawX = b.inbox.some((m) => JSON.stringify(m).includes('beacon-for-X-only'));

    assert.equal(aSawX, true, 'client A subscribed to X must receive its messages');
    assert.equal(bSawX, false, 'client B (subscribed to Y) must NOT receive X messages');

    await closeWs(a.ws);
    await closeWs(b.ws);
  });

  test('global broadcasts (e.g. agents list refresh) reach all clients', async () => {
    // After F2, broadcastGlobal() is the explicit opt-in. The agents/phases
    // handshake fired on connect uses ws.send (not broadcast) so we need a
    // different signal — but every connection currently receives an `agents`
    // message at handshake time. Use that as the global-delivery proof.
    const a = await openWs(server.wsUrl);
    const b = await openWs(server.wsUrl);

    await delay(200);

    const aGotAgents = a.inbox.some((m) => m.type === 'agents');
    const bGotAgents = b.inbox.some((m) => m.type === 'agents');

    assert.equal(aGotAgents, true, 'client A must receive global agents handshake');
    assert.equal(bGotAgents, true, 'client B must receive global agents handshake');

    await closeWs(a.ws);
    await closeWs(b.ws);
  });

  test('unsubscribe stops further session-tagged delivery', async () => {
    const sx = await createSession(server.baseUrl, 'Problem X — unsubscribe test');

    const a = await openWs(server.wsUrl);
    await delay(100);
    a.inbox.length = 0;

    await send(a.ws, { type: 'subscribe', sessionId: sx.id });
    await delay(50);
    await send(a.ws, { type: 'unsubscribe', sessionId: sx.id });
    await delay(50);

    // Trigger a session-tagged message — by going through a SECOND connection
    // (which has no subscriptions and shouldn't be the delivery path).
    const b = await openWs(server.wsUrl);
    await delay(100);
    await send(b.ws, {
      type: 'human-message',
      sessionId: sx.id,
      content: 'beacon-after-unsubscribe',
    });
    await delay(300);

    const aSaw = a.inbox.some((m) => JSON.stringify(m).includes('beacon-after-unsubscribe'));
    assert.equal(aSaw, false, 'unsubscribed client must not receive further messages');

    await closeWs(a.ws);
    await closeWs(b.ws);
  });
});
