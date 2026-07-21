// HLB-890 (+ B7 follow-up) — MCP getSession surfaces the composite quality
// score and the terminal outcome (both additive). warroom_get_session renders
// them; listSessions/getSession also carry them for programmatic callers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-qualityoutcome01';

test('MCP get_session surfaces quality score and outcome (HLB-890)', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  const client = new Client({ name: 'hlb890-test', version: '1.0.0' });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)')
      .run('mcpqoaaaaa1', 'scored session', now, now);
    db.prepare("UPDATE sessions SET quality_score = 0.75, outcome = 'complete' WHERE id = ?").run('mcpqoaaaaa1');
    db.close();

    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`));
    await client.connect(transport);
    const res = await client.callTool({ name: 'warroom_get_session', arguments: { sessionId: 'mcpqoaaaaa1' } });
    const text = (res.content || []).map(c => c.text || '').join('\n');

    assert.match(text, /Quality: 0\.750/, 'the composite quality score is surfaced');
    assert.match(text, /Outcome: complete/, 'the terminal outcome is surfaced');
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});
