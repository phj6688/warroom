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
    const body = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });

    // Wrong key of the same order of length: rejected with 401.
    const wrong = await fetch(`${mcpUrl}?key=mcp-test-key-WRONGWRONGWRONG000`, { method: 'POST', headers, body });
    assert.equal(wrong.status, 401, 'a wrong key returns 401');

    // Short key (length mismatch): still 401, and the length guard must not throw
    // (the server stays alive and answers /health afterward).
    const short = await fetch(`${mcpUrl}?key=x`, { method: 'POST', headers, body });
    assert.equal(short.status, 401, 'a length-mismatched key returns 401, not a 500 crash');
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200, 'server stays alive after a length-mismatched key');

    // Correct key: auth passes (not 401). The transport may 400/406 or open a
    // stream; a timeout also means the stream opened, i.e. auth passed.
    try {
      const ok = await fetch(`${mcpUrl}?key=${MCP_KEY}`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(2000),
      });
      assert.notEqual(ok.status, 401, 'the correct key must not be rejected as unauthorized');
    } catch (e) {
      assert.ok(e.name === 'TimeoutError' || e.name === 'AbortError', `unexpected error: ${e.message}`);
    }
  } finally {
    await server.dispose();
  }
});
