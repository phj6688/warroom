// HLB-899 — GET /metrics exposes minimal Prometheus-text counters (counts only,
// no secrets), auth-exempt like /health, including the B7 (HLB-797)
// deliberations_failed_total. Spawns the real server with WAR_ROOM_TOKEN set so
// the test also proves /metrics bypasses auth while other routes stay gated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnServer } from './_helpers.mjs';

test('GET /metrics returns counters incl. failed-deliberations, auth-exempt (HLB-899)', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: 'test-token-metrics' } });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    const insS = db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)');
    insS.run('mtok1aaaaa', 'p', now, now);
    insS.run('mtok2aaaaa', 'p', now, now);
    db.prepare("UPDATE sessions SET outcome = 'failed', failed_at = ? WHERE id = ?").run(now, 'mtok2aaaaa');
    db.close();

    // /metrics with NO auth header must succeed (auth-exempt like /health).
    const res = await fetch(`${server.baseUrl}/metrics`);
    assert.equal(res.status, 200, '/metrics is reachable without a token');
    assert.match(res.headers.get('content-type') || '', /text\/plain/);
    const body = await res.text();
    assert.match(body, /war_room_sessions_total 2/, 'two sessions total');
    assert.match(body, /war_room_deliberations_failed_total 1/, 'one failed session (B7 outcome)');
    assert.match(body, /war_room_sessions_active 0/);
    assert.match(body, /war_room_uptime_seconds \d+/);
    assert.ok(!body.includes('test-token-metrics'), 'no secret leaks into /metrics');

    // A normal route still enforces auth (proving /metrics is the exemption).
    const gated = await fetch(`${server.baseUrl}/api/sessions`);
    assert.equal(gated.status, 401, 'other routes stay gated when WAR_ROOM_TOKEN is set');
  } finally {
    await server.dispose();
  }
});
