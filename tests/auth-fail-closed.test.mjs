/**
 * A missing WAR_ROOM_TOKEN must be a refusal, not a mode.
 *
 * The gate used to read an absent token as "unauthenticated mode" and wave every
 * /api/* request and every WebSocket upgrade through. This file pins the
 * replacement behaviour at the only point where it can still be enforced for
 * both entry points at once: the boot.
 *
 * Matrix:
 *   token absent / empty / whitespace, no opt-in      -> exit 78, no listener
 *   opt-in with a value other than "true"             -> exit 78, no listener
 *   opt-in true + NODE_ENV=production                 -> exit 78, no listener
 *   opt-in true, non-production                       -> starts, says so
 *   token set + opt-in true                           -> token wins, still gated
 *
 * The assertions are on the refusal, not on the absence of a crash: an exit
 * code, a reason on stderr, and a port nothing answers on.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';
import { SERVER_ENTRY, REPO_ROOT, getFreePort, spawnServer, runNodeScript, delay } from './_helpers.mjs';

// EX_CONFIG from sysexits.h: the configuration is wrong, the process is not.
const EX_CONFIG = 78;

/**
 * Start the server with an exact environment and wait for it to die.
 *
 * `env` keys whose value is `undefined` are deleted rather than set to the
 * string "undefined", so "the variable is absent" is testable and is not the
 * same case as "the variable is empty".
 */
async function startAndAwaitExit(env, { timeoutMs = 15000 } = {}) {
  const port = await getFreePort();
  const tempDbDir = mkdtempSync(path.join(os.tmpdir(), 'warroom-failclosed-'));

  const childEnv = {
    ...process.env,
    PORT: String(port),
    ANTHROPIC_API_KEY: 'test-key-no-real-calls',
    WAR_ROOM_DB_PATH: path.join(tempDbDir, 'warroom.db'),
    NODE_ENV: 'test',
    WAR_ROOM_TOKEN: '',
    WAR_ROOM_ALLOW_ANONYMOUS: '',
    ...env,
  };
  for (const [k, v] of Object.entries(childEnv)) {
    if (v === undefined) delete childEnv[k];
  }

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (d) => { output += d.toString(); });
  proc.stderr.on('data', (d) => { output += d.toString(); });

  // The losing timer is cleared rather than left pending: a referenced 15s
  // timer per spawn would hold the runner open long after the assertions ran.
  let timer;
  const exitCode = await Promise.race([
    new Promise((resolve) => proc.once('exit', (code) => resolve(code))),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));

  if (exitCode === null) {
    proc.kill('SIGKILL');
    rmSync(tempDbDir, { recursive: true, force: true });
    assert.fail(`server stayed up for ${timeoutMs}ms instead of refusing to start\n${output}`);
  }

  // A refusing process must never have bound the port. Prove it rather than
  // inferring it from the exit: a listener that outlived the process would
  // still be reachable here.
  let reachable = true;
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
  } catch {
    reachable = false;
  }

  rmSync(tempDbDir, { recursive: true, force: true });
  return { exitCode, output, reachable, port };
}

function assertRefused(result, { reasonMatch }) {
  assert.equal(result.exitCode, EX_CONFIG, `expected exit ${EX_CONFIG} (EX_CONFIG), got ${result.exitCode}\n${result.output}`);
  assert.match(result.output, /refusing to start/i, `refusal must say so on stderr\n${result.output}`);
  assert.match(result.output, reasonMatch, `refusal must name the reason\n${result.output}`);
  assert.equal(result.reachable, false, 'a refusing process must not leave a listener behind');
}

describe('boot refuses when the gate has no token', () => {
  test('WAR_ROOM_TOKEN absent from the environment', async () => {
    const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: undefined });
    assertRefused(r, { reasonMatch: /WAR_ROOM_TOKEN is unset, empty or whitespace/ });
  });

  test('WAR_ROOM_TOKEN empty', async () => {
    const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: '' });
    assertRefused(r, { reasonMatch: /WAR_ROOM_TOKEN is unset, empty or whitespace/ });
  });

  test('WAR_ROOM_TOKEN whitespace only', async () => {
    const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: '   \t  ' });
    assertRefused(r, { reasonMatch: /WAR_ROOM_TOKEN is unset, empty or whitespace/ });
  });

  test('the refusal names both ways out', async () => {
    const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: '' });
    assert.match(r.output, /Set WAR_ROOM_TOKEN/, 'must tell the operator what to set');
    assert.match(r.output, /WAR_ROOM_ALLOW_ANONYMOUS=true/, 'must name the local escape hatch');
  });
});

describe('the local escape hatch cannot be reached by accident', () => {
  test('WAR_ROOM_ALLOW_ANONYMOUS=false still refuses', async () => {
    const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: '', WAR_ROOM_ALLOW_ANONYMOUS: 'false' });
    assertRefused(r, { reasonMatch: /WAR_ROOM_TOKEN is unset, empty or whitespace/ });
  });

  test('a truthy-looking value that is not "true" still refuses', async () => {
    // "1", "yes" and "on" all read as enabled to a human and to plenty of
    // config parsers. Only the word counts, case and padding aside.
    for (const value of ['1', 'yes', 'on', 'enabled']) {
      const r = await startAndAwaitExit({ WAR_ROOM_TOKEN: '', WAR_ROOM_ALLOW_ANONYMOUS: value });
      assertRefused(r, { reasonMatch: /WAR_ROOM_TOKEN is unset, empty or whitespace/ });
    }
  });

  test('opt-in is refused under NODE_ENV=production', async () => {
    const r = await startAndAwaitExit({
      WAR_ROOM_TOKEN: '',
      WAR_ROOM_ALLOW_ANONYMOUS: 'true',
      NODE_ENV: 'production',
    });
    assertRefused(r, { reasonMatch: /not honoured when NODE_ENV=production/ });
  });
});

describe('the gate itself refuses, not only the boot check', () => {
  // Defence in depth. If someone deletes the boot assertion, or adds an entry
  // point that never calls it, the middleware must still refuse rather than
  // fall through to open. This drives lib/auth.js directly with no token and no
  // opt-in, which is the state the boot check normally makes unreachable.
  test('requireAuth 401s and requireAuthWS rejects with no token and no opt-in', async () => {
    const script = `
      const { requireAuth, requireAuthWS, ANONYMOUS_ACCESS, authPosture } = require('./lib/auth');
      const calls = { next: 0, status: null };
      const res = {
        status(code) { calls.status = code; return this; },
        json() { return this; },
      };
      requireAuth({ headers: {} }, res, () => { calls.next++; });
      const wsNoCreds = requireAuthWS({ headers: {}, url: '/' });
      const wsGuessedHeader = requireAuthWS({ headers: { authorization: 'Bearer guess' }, url: '/' });
      const wsGuessedQuery = requireAuthWS({ headers: {}, url: '/?token=guess' });
      const wsGuessedProto = requireAuthWS({ headers: { 'sec-websocket-protocol': 'guess' }, url: '/' });
      const wsEmptyToken = requireAuthWS({ headers: { authorization: 'Bearer ' }, url: '/?token=' });
      process.stdout.write(JSON.stringify({
        anonymousAccess: ANONYMOUS_ACCESS,
        posture: authPosture(),
        nextCalls: calls.next,
        status: calls.status,
        wsNoCreds, wsGuessedHeader, wsGuessedQuery, wsGuessedProto, wsEmptyToken,
      }));
    `;
    const { code, stdout, stderr } = await runNodeScript(script, {
      env: { WAR_ROOM_TOKEN: '', WAR_ROOM_ALLOW_ANONYMOUS: '', NODE_ENV: 'test' },
    });
    assert.equal(code, 0, `script failed: ${stderr}`);
    const r = JSON.parse(stdout);

    assert.equal(r.anonymousAccess, false, 'no token and no opt-in must never read as anonymous access');
    assert.equal(r.posture, 'enforced');
    assert.equal(r.nextCalls, 0, 'requireAuth must not call next() without a token');
    assert.equal(r.status, 401, 'requireAuth must answer 401');
    for (const [name, allowed] of Object.entries({
      wsNoCreds: r.wsNoCreds,
      wsGuessedHeader: r.wsGuessedHeader,
      wsGuessedQuery: r.wsGuessedQuery,
      wsGuessedProto: r.wsGuessedProto,
      wsEmptyToken: r.wsEmptyToken,
    })) {
      assert.equal(allowed, false, `the upgrade must reject ${name}`);
    }
  });
});

describe('the running instance reports its own posture', () => {
  test('an anonymous instance says so on boot, on /health and on /metrics', async () => {
    const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', WAR_ROOM_ALLOW_ANONYMOUS: 'true' } });
    try {
      const boot = server.logs.join('');
      assert.match(boot, /WAR_ROOM_ALLOW_ANONYMOUS/, 'boot log must name the reason the gate is open');
      assert.match(boot, /warn/i, 'an open gate is a warning, not an info line');

      const health = await (await fetch(`${server.baseUrl}/health`)).json();
      assert.equal(health.auth, 'anonymous', '/health must report the open gate');

      const metrics = await (await fetch(`${server.baseUrl}/metrics`)).text();
      assert.match(metrics, /war_room_auth_enforced 0/, '/metrics must expose the open gate to a scrape');
    } finally {
      await server.dispose();
    }
  });

  test('a gated instance reports enforced on /health and /metrics', async () => {
    const server = await spawnServer({ env: { WAR_ROOM_TOKEN: 'posture-fixture-token' } });
    try {
      const health = await (await fetch(`${server.baseUrl}/health`)).json();
      assert.equal(health.auth, 'enforced');

      const metrics = await (await fetch(`${server.baseUrl}/metrics`)).text();
      assert.match(metrics, /war_room_auth_enforced 1/);
      assert.ok(!metrics.includes('posture-fixture-token'), 'the token must never reach the metrics body');
    } finally {
      await server.dispose();
    }
  });
});

describe('a configured token outranks the escape hatch', () => {
  // The regression this guards: someone reads WAR_ROOM_ALLOW_ANONYMOUS as a
  // global bypass instead of a fallback for the no-token case, and the gate
  // opens on a deployment that has a perfectly good token.
  test('token set + WAR_ROOM_ALLOW_ANONYMOUS=true keeps HTTP and WS gated', async () => {
    const TOKEN = 'both-set-fixture-token';
    const server = await spawnServer({
      env: { WAR_ROOM_TOKEN: TOKEN, WAR_ROOM_ALLOW_ANONYMOUS: 'true' },
    });
    try {
      const anon = await fetch(`${server.baseUrl}/api/sessions`);
      assert.equal(anon.status, 401, 'the opt-in must not open a route on a tokened instance');

      const authed = await fetch(`${server.baseUrl}/api/sessions`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(authed.status, 200, 'the real token must still work');

      const health = await (await fetch(`${server.baseUrl}/health`)).json();
      assert.equal(health.auth, 'enforced');

      // The status comes from the HTTP response the upgrade got, never from the
      // close event. A socket that dies without answering would otherwise read
      // as a 401 and let a real regression pass.
      const wsRejected = await new Promise((resolve) => {
        const ws = new WebSocket(server.wsUrl);
        let opened = false;
        ws.on('open', () => { opened = true; ws.close(); });
        ws.on('unexpected-response', (_req, res) => {
          resolve({ opened: false, status: res.statusCode });
          try { ws.terminate(); } catch {}
        });
        ws.on('error', () => {});
        ws.on('close', () => resolve({ opened, status: null }));
      });
      assert.equal(wsRejected.opened, false, 'the opt-in must not open the socket either');
      assert.equal(wsRejected.status, 401, 'the upgrade must be answered with 401, not merely dropped');
    } finally {
      await server.dispose();
    }
  });
});
