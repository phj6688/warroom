/**
 * /mcp carries its own gate, so the WAR_ROOM_TOKEN gate must not sit in front
 * of it.
 *
 * Express runs the middleware registered by setupRoutes before the /mcp handler
 * registered by setupMCPServer. Without an exemption, an instance with a token
 * set answers 401 to every MCP request before mcp/http.js ever checks the key,
 * so a client would need the key in the url AND the bearer in a header. A
 * url-only MCP client entry cannot express that, which makes the route
 * unreachable rather than protected.
 *
 * The exemption is exact-match, and the second half of this file is the reason
 * why: a prefix match on /mcp also exempts /mcp-anything, which is how a
 * sibling app on this platform turned its own skip rule into a public bypass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './_helpers.mjs';

const TOKEN = 'mcp-exemption-fixture-token';
const MCP_KEY = 'mcp-exemption-fixture-key-0123456789';

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const INIT_BODY = JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });

async function withGatedServer(fn) {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN, MCP_API_KEY: MCP_KEY } });
  try {
    return await fn(server);
  } finally {
    await server.dispose();
  }
}

describe('/mcp is gated by MCP_API_KEY, not by WAR_ROOM_TOKEN', () => {
  test('the query key alone reaches the transport on a tokened instance', async () => {
    await withGatedServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/mcp?key=${MCP_KEY}`, {
        method: 'POST', headers: MCP_HEADERS, body: INIT_BODY,
      });
      assert.notEqual(res.status, 401, 'a correct MCP key must not be refused by the bearer gate');
    });
  });

  test('the key as a bearer also reaches the transport', async () => {
    // mcp/http.js accepts the key in either place. Both have to clear the
    // route-level gate, or the advertised contract is a lie in one direction.
    await withGatedServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${MCP_KEY}` },
        body: INIT_BODY,
      });
      assert.notEqual(res.status, 401, 'the MCP key as a bearer must not be refused');
    });
  });

  test('a wrong key is still refused, by MCP rather than by the bearer gate', async () => {
    await withGatedServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/mcp?key=wrong-key-same-length-0123456789`, {
        method: 'POST', headers: MCP_HEADERS, body: INIT_BODY,
      });
      assert.equal(res.status, 401, 'a wrong MCP key must be refused');
      const body = await res.json();
      assert.equal(body.error?.code, -32001, 'the refusal must come from the MCP key check, not the route gate');
    });
  });

  test('no credential at all is refused', async () => {
    await withGatedServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/mcp`, {
        method: 'POST', headers: MCP_HEADERS, body: INIT_BODY,
      });
      assert.equal(res.status, 401, 'the exemption must not make /mcp anonymous');
    });
  });

  test('the war-room token is not an MCP credential', async () => {
    // The two gates stay separate in both directions: holding one must not
    // grant the other.
    await withGatedServer(async (server) => {
      const res = await fetch(`${server.baseUrl}/mcp`, {
        method: 'POST',
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: INIT_BODY,
      });
      assert.equal(res.status, 401, 'WAR_ROOM_TOKEN must not open /mcp');
    });
  });
});

describe('the exemption is exact, not a prefix', () => {
  // The regression: a skip rule written as a prefix or an unanchored pattern
  // exempts every sibling path that starts with the same characters. Those
  // paths reach the app's own routing, and anything that answers there would
  // answer anonymously.
  // No '..' case here: fetch normalises the path before it leaves the client,
  // so such a test would assert on a request the server never sees.
  for (const path of ['/mcp-anything', '/mcpx', '/mcp2/sessions', '/mcp.json']) {
    test(`${path} stays behind the bearer gate`, async () => {
      await withGatedServer(async (server) => {
        const res = await fetch(`${server.baseUrl}${path}`, { method: 'POST', headers: MCP_HEADERS, body: INIT_BODY });
        assert.equal(res.status, 401, `${path} must not inherit the /mcp exemption`);
      });
    });
  }

  test('the exempt paths are only the three intended ones', async () => {
    await withGatedServer(async (server) => {
      for (const path of ['/health', '/metrics']) {
        const res = await fetch(`${server.baseUrl}${path}`);
        assert.equal(res.status, 200, `${path} stays reachable for a probe`);
      }
      // A sample of ordinary routes, to prove the set did not widen.
      for (const path of ['/api/sessions', '/api/agents', '/api/health']) {
        const res = await fetch(`${server.baseUrl}${path}`);
        assert.equal(res.status, 401, `${path} must still require the bearer token`);
      }
    });
  });
});

describe('the MCP key reports its own state', () => {
  test('an unset MCP_API_KEY warns that no client can reach /mcp', async () => {
    const server = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN, MCP_API_KEY: '' } });
    try {
      const boot = server.logs.join('');
      assert.match(boot, /MCP_API_KEY unset/, 'a random per-boot key must not be silent');
      assert.match(boot, /warn/i, 'an unreachable transport is a warning');
    } finally {
      await server.dispose();
    }
  });
});
