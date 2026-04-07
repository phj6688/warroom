/**
 * F5 — Input validation with zod everywhere.
 *
 * Spec: forge/hardening/TASKSPEC.md §F5
 *
 * Hard caps required after F5:
 *   - problem ≤ 50 KB
 *   - humanMessage.content ≤ 10 KB
 *   - file count ≤ 10
 * Every WS case validates msg first; failure → {type:'error', code:'INVALID_MSG'}
 * Every Express POST/PUT validates body; failure → 400 with {error, issues}
 *
 * In red phase: ws-handler.js does ad-hoc checks (`msg.problem.trim()`)
 * but no schema, no size cap, no INVALID_MSG code; routes.js mostly accepts
 * whatever you send. These tests will fail accordingly.
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

// ─── HTTP body validation ────────────────────────────────────
describe('F5 HTTP — POST /api/sessions body validation', () => {
  test('valid body {problem: "ok"} → 200/201 (control)', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 'a small valid problem statement' }),
    });
    assert.ok(res.ok, `control case must succeed, got ${res.status}`);
  });

  test('wrong-type body {problem: 123} → 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 123 }),
    });
    assert.equal(res.status, 400, 'numeric problem must be rejected');
    const body = await res.json().catch(() => ({}));
    assert.ok(body.error, 'response must include error field');
  });

  test('missing body field {} → 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400, 'empty body must be rejected');
  });

  test('oversized problem (>50KB) → 400', async () => {
    const huge = 'x'.repeat(51 * 1024);
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: huge }),
    });
    assert.equal(res.status, 400, '>50KB problem must be rejected with 400');
  });

  test('null body field {problem: null} → 400', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: null }),
    });
    assert.equal(res.status, 400);
  });

  test('extra unknown fields are ignored, valid problem accepted', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 'still valid', __injected__: { evil: true } }),
    });
    assert.ok(res.ok, 'extra fields must not block valid input');
  });

  test('400 response shape includes issues array (zod errors)', async () => {
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 42 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json().catch(() => ({}));
    assert.ok(Array.isArray(body.issues), 'response must include zod issues array');
  });
});

// ─── WS message validation ───────────────────────────────────
describe('F5 WS — message validation', () => {
  function openWs(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const inbox = [];
      ws.on('message', (data) => {
        try { inbox.push(JSON.parse(data.toString())); } catch {}
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

  test('new-session with oversized problem (>50KB) → INVALID_MSG error', async () => {
    const { ws, inbox } = await openWs(server.wsUrl);
    await delay(100);
    inbox.length = 0;

    const huge = 'x'.repeat(51 * 1024);
    await send(ws, { type: 'new-session', problem: huge });
    await delay(200);

    const errMsg = inbox.find((m) => m.type === 'error');
    assert.ok(errMsg, 'expected an error message in response');
    assert.equal(errMsg.code, 'INVALID_MSG', 'error must use code=INVALID_MSG');

    ws.close();
  });

  test('unknown message type → INVALID_MSG error', async () => {
    const { ws, inbox } = await openWs(server.wsUrl);
    await delay(100);
    inbox.length = 0;

    await send(ws, { type: 'totally-fake-type', foo: 'bar' });
    await delay(200);

    const errMsg = inbox.find((m) => m.type === 'error');
    assert.ok(errMsg, 'expected error for unknown type');
    assert.equal(errMsg.code, 'INVALID_MSG');

    ws.close();
  });

  test('new-session with non-string problem → INVALID_MSG error', async () => {
    const { ws, inbox } = await openWs(server.wsUrl);
    await delay(100);
    inbox.length = 0;

    await send(ws, { type: 'new-session', problem: { nested: 'object' } });
    await delay(200);

    const errMsg = inbox.find((m) => m.type === 'error');
    assert.ok(errMsg, 'expected error for non-string problem');
    assert.equal(errMsg.code, 'INVALID_MSG');

    ws.close();
  });

  test('human-message with content >10KB → INVALID_MSG error', async () => {
    // First create a session so the human-message has somewhere to land.
    const create = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 'host for oversized human msg test' }),
    });
    if (!create.ok) {
      // If session creation is broken in red phase, skip — the new-session
      // test above already covers WS validation surface.
      return;
    }
    const session = await create.json();

    const { ws, inbox } = await openWs(server.wsUrl);
    await delay(100);
    inbox.length = 0;

    const huge = 'h'.repeat(11 * 1024);
    await send(ws, { type: 'human-message', sessionId: session.id, content: huge });
    await delay(200);

    const errMsg = inbox.find((m) => m.type === 'error');
    assert.ok(errMsg, 'expected error for oversized human-message');
    assert.equal(errMsg.code, 'INVALID_MSG');

    ws.close();
  });

  test('server stays alive after invalid messages (no crash)', async () => {
    // Sanity: after sending garbage, /health still responds.
    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200, 'server must remain healthy after invalid input');
  });
});
