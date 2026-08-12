// warroom_get_session rendered `Status: ${s.active ? 'Active' : 'Complete'}`,
// so every session that was not running read as Complete: a run killed by a
// redeploy at Problem Framing looked exactly like one that reached Synthesis.
// The MCP caller had no way to tell them apart, and no way to see why a run
// died — the per-turn provider errors were already in the DB but nothing
// surfaced them. Status now names the real terminal state, carries phases
// completed, and reports failed turns with the last provider error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const mcpKey = 'test-mcp-key-session-status';

function seed(dbPath) {
  const db = new Database(dbPath);
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, outcome)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('sess-stopped', 'killed by a redeploy at framing', 0, 0, now, now, 'stopped');
  ins.run('sess-complete', 'ran the whole room', 4, 0, now, now, 'complete');
  ins.run('sess-failed', 'provider refused every turn', 4, 0, now, now, 'failed');
  const metric = db.prepare(`INSERT INTO search_metrics (session_id, agent_id, agent_tier, path, event_type, error, created_at)
                             VALUES (?, ?, 'D', 'none', 'agent_turn_complete', ?, ?)`);
  metric.run('sess-failed', 'process-architect', 'Gateway error (402): can only afford 20722', now);
  metric.run('sess-failed', 'research-scout', 'Gateway error (429): model_cooldown', now + 1);
  db.close();
}

async function detail(client, sessionId) {
  const res = await client.callTool({ name: 'warroom_get_session', arguments: { sessionId } });
  return (res.content || []).map(c => c.text || '').join('\n');
}

test('warroom_get_session tells a stopped run apart from a completed one', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: mcpKey } });
  try {
    seed(server.dbPath);
    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${mcpKey}`));
    const client = new Client({ name: 'session-status-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const stopped = await detail(client, 'sess-stopped');
      assert.match(stopped, /Status: Stopped/, 'a run that ended early must say so');
      assert.doesNotMatch(stopped, /Status: Complete/, 'and must not claim completion');
      assert.match(stopped, /1\/5/, 'phases completed must be visible');

      const complete = await detail(client, 'sess-complete');
      assert.match(complete, /Status: Complete/, 'a finished run still reads as complete');
      assert.match(complete, /5\/5/);

      const failed = await detail(client, 'sess-failed');
      assert.match(failed, /Status: Failed/, 'a run with no output reads as failed');
      assert.match(failed, /Failed turns: 2/, 'the failed-turn count is surfaced');
      assert.match(failed, /Last error: Gateway error \(429\)/, 'the most recent provider error is surfaced, not the first');
    } finally {
      await client.close();
    }
  } finally {
    await server.dispose();
  }
});
