/**
 * F1 — Bearer auth gate on HTTP and WebSocket.
 *
 * Spec: forge/hardening/TASKSPEC.md §F1
 *
 * Matrix:
 *   1. WAR_ROOM_TOKEN=secret + correct bearer        → 200
 *   2. WAR_ROOM_TOKEN=secret + wrong bearer          → 401
 *   3. WAR_ROOM_TOKEN=secret + missing Authorization → 401
 *   4. no token + WAR_ROOM_ALLOW_ANONYMOUS=true      → 200 (open, and it says so)
 *   5. WS upgrade: same matrix
 *
 * No token and no opt-in is not in this matrix: the server refuses to start,
 * which tests/auth-fail-closed.test.mjs covers.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { spawnServer, delay } from './_helpers.mjs';

const TOKEN = 'session0-secret-token-fixture';

// ─── Server lifecycles ───────────────────────────────────────
let authedServer;      // WAR_ROOM_TOKEN=TOKEN
let anonymousServer;   // no token, anonymous access asked for by name

before(async () => {
  authedServer = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN } });
  anonymousServer = await spawnServer({
    env: { WAR_ROOM_TOKEN: '', WAR_ROOM_ALLOW_ANONYMOUS: 'true' },
  });
});

after(async () => {
  await authedServer?.dispose();
  await anonymousServer?.dispose();
});

// ─── HTTP matrix ─────────────────────────────────────────────
describe('F1 HTTP — auth gate matrix', () => {
  test('token set + correct bearer → 200', async () => {
    const res = await fetch(`${authedServer.baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200, 'authorized request must succeed');
  });

  test('token set + wrong bearer → 401', async () => {
    const res = await fetch(`${authedServer.baseUrl}/api/sessions`, {
      headers: { Authorization: 'Bearer not-the-real-token' },
    });
    assert.equal(res.status, 401, 'wrong token must be rejected');
  });

  test('token set + no Authorization header → 401', async () => {
    const res = await fetch(`${authedServer.baseUrl}/api/sessions`);
    assert.equal(res.status, 401, 'missing Authorization must be rejected');
  });

  test('token set + Bearer with wrong scheme → 401', async () => {
    const res = await fetch(`${authedServer.baseUrl}/api/sessions`, {
      headers: { Authorization: `Basic ${Buffer.from(TOKEN).toString('base64')}` },
    });
    assert.equal(res.status, 401, 'non-Bearer scheme must be rejected');
  });

  test('no token + explicit anonymous opt-in → 200', async () => {
    const res = await fetch(`${anonymousServer.baseUrl}/api/sessions`);
    assert.equal(res.status, 200, 'an instance opened on purpose must serve normally');
  });

  test('/health bypasses auth even when token is set', async () => {
    // Health probes shouldn't require credentials.
    const res = await fetch(`${authedServer.baseUrl}/health`);
    assert.equal(res.status, 200, '/health must always be reachable');
  });

  test('anonymous mode boot logs a loud warning', async () => {
    // Look back in the captured boot logs for a WARN-style line.
    const combined = anonymousServer.logs.join('');
    const hasWarn = /WAR_ROOM_ALLOW_ANONYMOUS/.test(combined) && /(warn|WARN|⚠)/.test(combined);
    assert.ok(hasWarn, `expected boot warning about the open gate, got: ${combined.slice(-500)}`);
  });
});

// ─── WebSocket matrix ────────────────────────────────────────
describe('F1 WS — auth gate matrix', () => {
  // Helper that opens a WS and returns {code, opened, closeReason}.
  function tryConnect(wsUrl, headers = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl, { headers });
      let opened = false;
      ws.on('open', () => {
        opened = true;
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) => {
        resolve({ status: res.statusCode, opened: false });
        try { ws.terminate(); } catch {}
      });
      ws.on('error', () => { /* swallow — close handler reports */ });
      // A rejected upgrade reports the status of the HTTP response it got, and
      // nothing else. Deriving 401 from a close event would make the rejection
      // assertions pass on a socket that was dropped without an answer.
      ws.on('close', (code, reason) => {
        resolve({ status: opened ? 200 : null, opened, code, reason: reason?.toString() });
      });
    });
  }

  test('WS upgrade with correct bearer → opens', async () => {
    const r = await tryConnect(authedServer.wsUrl, { Authorization: `Bearer ${TOKEN}` });
    assert.equal(r.opened, true, 'authorized WS must connect');
  });

  test('WS upgrade with wrong bearer → 401', async () => {
    const r = await tryConnect(authedServer.wsUrl, { Authorization: 'Bearer wrong' });
    assert.equal(r.opened, false, 'wrong-token WS must be rejected');
    assert.equal(r.status, 401);
  });

  test('WS upgrade with no Authorization → 401', async () => {
    const r = await tryConnect(authedServer.wsUrl);
    assert.equal(r.opened, false, 'no-token WS must be rejected');
    assert.equal(r.status, 401);
  });

  test('WS upgrade with a wrong ?token= query param → 401', async () => {
    // The upgrade takes a token from three places. A regression that only
    // closes the header path leaves the other two open.
    const r = await tryConnect(`${authedServer.wsUrl}/?token=wrong`);
    assert.equal(r.opened, false, 'wrong query-param token must be rejected');
    assert.equal(r.status, 401);
  });

  test('WS upgrade with a wrong Sec-WebSocket-Protocol token → 401', async () => {
    const r = await tryConnect(authedServer.wsUrl, { 'Sec-WebSocket-Protocol': 'wrong' });
    assert.equal(r.opened, false, 'wrong subprotocol token must be rejected');
    assert.equal(r.status, 401);
  });

  test('WS upgrade against an instance opened on purpose → opens', async () => {
    const r = await tryConnect(anonymousServer.wsUrl);
    assert.equal(r.opened, true, 'anonymous mode must allow WS connect');
  });
});
