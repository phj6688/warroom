/**
 * F1 — Bearer auth gate on HTTP and WebSocket.
 *
 * Spec: forge/hardening/TASKSPEC.md §F1
 *
 * Matrix:
 *   1. WAR_ROOM_TOKEN=secret + correct bearer        → 200
 *   2. WAR_ROOM_TOKEN=secret + wrong bearer          → 401
 *   3. WAR_ROOM_TOKEN=secret + missing Authorization → 401
 *   4. WAR_ROOM_TOKEN unset                          → 200 (unauth mode + warn)
 *   5. WS upgrade: same matrix
 *
 * In red phase, the server has no auth middleware so cases 1, 2, 3 will all
 * return 200 — failing this test as intended.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { spawnServer, delay } from './_helpers.mjs';

const TOKEN = 'session0-secret-token-fixture';

// ─── Server lifecycles ───────────────────────────────────────
let authedServer;     // WAR_ROOM_TOKEN=TOKEN
let unauthedServer;   // WAR_ROOM_TOKEN unset

before(async () => {
  authedServer = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN } });
  unauthedServer = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
});

after(async () => {
  await authedServer?.dispose();
  await unauthedServer?.dispose();
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

  test('token unset → 200 (unauth mode)', async () => {
    const res = await fetch(`${unauthedServer.baseUrl}/api/sessions`);
    assert.equal(res.status, 200, 'unauth mode must serve normally');
  });

  test('/health bypasses auth even when token is set', async () => {
    // Health probes shouldn't require credentials.
    const res = await fetch(`${authedServer.baseUrl}/health`);
    assert.equal(res.status, 200, '/health must always be reachable');
  });

  test('unauth mode boot logs a loud warning', async () => {
    // Look back in the captured boot logs for a WARN-style line.
    const combined = unauthedServer.logs.join('');
    const hasWarn = /WAR_ROOM_TOKEN/.test(combined) && /(warn|WARN|⚠)/.test(combined);
    assert.ok(hasWarn, `expected boot warning about missing WAR_ROOM_TOKEN, got: ${combined.slice(-500)}`);
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
      ws.on('close', (code, reason) => {
        resolve({ status: opened ? 200 : 401, opened, code, reason: reason?.toString() });
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

  test('WS upgrade against unauth-mode server → opens regardless', async () => {
    const r = await tryConnect(unauthedServer.wsUrl);
    assert.equal(r.opened, true, 'unauth mode must allow WS connect');
  });
});
