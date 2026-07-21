// HLB-887 — warroom_export_session gains an additive `mode` argument. Omitted
// (or full_transcript) returns the full transcript unchanged; end_result
// returns just the Synthesis verdict. Driven through a real MCP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-exportmode00001';

test('warroom_export_session mode: default full transcript vs end_result (HLB-887)', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  const client = new Client({ name: 'hlb887-test', version: '1.0.0' });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    const insS = db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)');
    const insM = db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insS.run('mcpexpaaaa1', 'export me', now, now);
    insM.run('em1', 'mcpexpaaaa1', 'research-scout', 'Research Scout', '', '', 'FRAMING-ONLY-CONTENT', 'Framing', now);
    insM.run('em2', 'mcpexpaaaa1', 'process-architect', 'Process Architect', '', '', 'SYNTH-VERDICT-CONTENT', 'Synthesis', now + 1);
    db.close();

    const transport = new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`));
    await client.connect(transport);
    const exportIt = async (args) => {
      const res = await client.callTool({ name: 'warroom_export_session', arguments: args });
      return (res.content || []).map(c => c.text || '').join('\n');
    };

    // Omitted mode = full transcript (unchanged): has the Deliberation section and both messages.
    const full = await exportIt({ sessionId: 'mcpexpaaaa1' });
    assert.match(full, /## Deliberation/, 'default export is the full transcript');
    assert.match(full, /FRAMING-ONLY-CONTENT/);
    assert.match(full, /SYNTH-VERDICT-CONTENT/);

    // end_result = synthesis only: the verdict, not the framing message.
    const end = await exportIt({ sessionId: 'mcpexpaaaa1', mode: 'end_result' });
    assert.match(end, /## Final Synthesis/, 'end_result surfaces the synthesis section');
    assert.match(end, /SYNTH-VERDICT-CONTENT/, 'end_result includes the verdict');
    assert.ok(!end.includes('FRAMING-ONLY-CONTENT'), 'end_result excludes non-synthesis messages');
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});
