// HLB-342 fix 4 — the MCP getSession path carries the per-route costBreakdown
// the WS payload already exposes, and renders it. Drives the real /mcp
// Streamable HTTP endpoint with the SDK client: spawn the server, seed a
// completed session (with a cost breakdown) directly into the temp DB the
// server opened, then call warroom_get_session and assert the cost surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

test('warroom_get_session payload exposes costBreakdown (HLB-342)', async () => {
  // No WAR_ROOM_TOKEN: the server runs in unauth mode so only the MCP ?key=
  // gate applies, keeping the client wiring to the one protocol under test.
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
  try {
    // The MCP key the server minted; spawnServer doesn't pass one, so the
    // server generated a random key and logged the /mcp?key=... line.
    const keyLine = await waitForLog(server, /\/mcp\?key=([a-f0-9]+)/, 6000);
    const mcpKey = keyLine.match(/\/mcp\?key=([a-f0-9]+)/)[1];

    // Seed a completed session with a known cost + per-route breakdown.
    const db = new Database(server.dbPath);
    const sid = 'sess-cost-test';
    const now = Date.now();
    db.prepare(`INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, total_tokens, total_cost_usd, cost_breakdown)
                VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`)
      .run(sid, 'cost payload probe', 5, now, now, 123456, 0.0042,
           JSON.stringify({ 'anthropic-api': 0.0042 }));
    db.close();

    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${mcpKey}`));
    const client = new Client({ name: 'hlb342-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const res = await client.callTool({ name: 'warroom_get_session', arguments: { sessionId: sid } });
      const text = (res.content || []).map(c => c.text || '').join('\n');
      assert.match(text, new RegExp(sid), 'session id rendered');
      // The breakdown the WS payload carries must reach the MCP detail.
      assert.match(text, /anthropic-api/, 'per-route cost breakdown rendered');
    } finally {
      await client.close();
    }
  } finally {
    await server.dispose();
  }
});

function waitForLog(server, re, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const joined = server.logs.join('');
      if (re.test(joined)) return resolve(joined.match(re)[0]);
      if (Date.now() > deadline) return reject(new Error(`log not seen: ${re}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}
