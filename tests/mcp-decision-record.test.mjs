// HLB-888 — the warroom_get_decision_record MCP tool returns the verbatim
// Decision Record JSON for a session (available:false for a failed or
// synthesis-less one). Spawns the real server, seeds the temp DB, and drives
// the tool through a real MCP client over the StreamableHTTP transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-decisionrecord01';

test('warroom_get_decision_record returns the verbatim verdict, available:false for failed (HLB-888)', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  const client = new Client({ name: 'hlb888-test', version: '1.0.0' });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    const insS = db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)');
    const insM = db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insS.run('mcpdraaaaa1', 'ship it?', now, now);
    insM.run('mm1', 'mcpdraaaaa1', 'process-architect', 'Process Architect', '', '', 'VERDICT: ship it.', 'Synthesis', now);
    insS.run('mcpdrfailed', 'stormed', now, now);
    db.prepare("UPDATE sessions SET outcome = 'failed', failed_at = ? WHERE id = ?").run(now, 'mcpdrfailed');
    db.close();

    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`));
    await client.connect(transport);

    const call = async (sessionId) => {
      const res = await client.callTool({ name: 'warroom_get_decision_record', arguments: { sessionId } });
      return JSON.parse((res.content || []).map(c => c.text || '').join('\n'));
    };

    const rec = await call('mcpdraaaaa1');
    assert.equal(rec.available, true, 'synthesized session -> available');
    assert.match(rec.verdict, /VERDICT: ship it\./, 'verbatim verdict returned via MCP');
    assert.equal(rec.outcome, 'complete');

    const failed = await call('mcpdrfailed');
    assert.equal(failed.available, false, 'failed session -> not available');
    assert.equal(failed.outcome, 'failed');
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});
