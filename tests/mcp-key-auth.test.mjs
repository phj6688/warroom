// HLB-881 — the MCP key must not be printed to logs (it lands in docker logs on
// a public-repo app) and must be compared in constant time with a length guard
// so a length mismatch cannot throw. Spawns the real server with a known key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-abcdef0123456789';

test('MCP key is redacted from the boot log and compared in constant time (HLB-881)', async () => {
  const server = await spawnServer({ env: { MCP_API_KEY: MCP_KEY } });
  try {
    const boot = server.logs.join('');
    assert.match(boot, /mounted at \/mcp/, 'the mount line is still logged');
    assert.ok(!boot.includes(MCP_KEY), 'the boot log must not contain the literal MCP key');
    assert.match(boot, /auth required/, 'the mount line advertises auth without the key');

    const mcpUrl = `${server.baseUrl}/mcp`;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const initBody = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });

    // A wrong key of the SAME length as the real key exercises the constant-time
    // compare (timingSafeEqual), not merely the length guard: still 401.
    const wrongSameLen = 'mcp-test-key-ZZZZZZ0123456789';
    assert.equal(wrongSameLen.length, MCP_KEY.length, 'wrong key must match the real key length');
    const wrong = await fetch(`${mcpUrl}?key=${wrongSameLen}`, { method: 'POST', headers, body: initBody });
    assert.equal(wrong.status, 401, 'an equal-length wrong key returns 401');

    // A shorter key exercises the length guard, which must return false without
    // throwing: still 401, and the server stays alive afterward.
    const short = await fetch(`${mcpUrl}?key=x`, { method: 'POST', headers, body: initBody });
    assert.equal(short.status, 401, 'a length-mismatched key returns 401, not a 500 crash');
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'server stays alive after a length-mismatched key');

    // The correct key passes auth: not rejected with 401. A non-initialize
    // request with no session id makes the transport return a deterministic 4xx
    // (bad request) rather than opening a long-lived stream, so no timeout is
    // needed and a hang would fail the test rather than pass it.
    const noSession = JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} });
    const ok = await fetch(`${mcpUrl}?key=${MCP_KEY}`, { method: 'POST', headers, body: noSession });
    assert.notEqual(ok.status, 401, 'the correct key must not be rejected as unauthorized');
  } finally {
    await server.dispose();
  }
});
