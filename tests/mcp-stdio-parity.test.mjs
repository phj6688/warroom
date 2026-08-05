// The stdio transport shares tools.js with the HTTP one but implements its ops
// over REST. Two registered tools (warroom_get_decision_record,
// warroom_attach_files) had no stdio op at all and answered "ops.X is not a
// function"; the model tools are new. Drive the real stdio binary against a
// real server so the two adapters cannot drift apart unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnServer, REPO_ROOT } from './_helpers.mjs';

function textOf(res) {
  return (res.content || []).map(c => c.text || '').join('\n');
}

test('stdio transport: every tool has an op, and the model tools reach the same store', async () => {
  const server = await spawnServer({
    env: { WAR_ROOM_TOKEN: '', ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: '', OPENROUTER_API_KEY: 'test-openrouter' },
  });
  const client = new Client({ name: 'stdio-parity-test', version: '1.0.0' });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)')
      .run('stdioparity1', 'decide something', now, now);
    db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('sp1', 'stdioparity1', 'process-architect', 'Process Architect', '', '', 'DECISION: ship it', 'Synthesis', now);
    db.close();

    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'mcp', 'stdio.mjs')],
      env: { ...process.env, WAR_ROOM_URL: server.baseUrl, WAR_ROOM_TOKEN: '' },
    }));

    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    // Both transports advertise the same tool set.
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.ok(names.includes('warroom_get_decision_record'));
    assert.ok(names.includes('warroom_set_model'));
    assert.ok(names.length >= 27, `stdio advertises the full tool set, got ${names.length}`);

    // The two tools that had no stdio op.
    const rec = await call('warroom_get_decision_record', { sessionId: 'stdioparity1' });
    assert.notEqual(rec.isError, true, textOf(rec));
    assert.ok(!/is not a function/.test(textOf(rec)), 'decision record has a stdio op');
    assert.match(textOf(rec), /ship it/, 'returns the real verdict');

    const attach = await call('warroom_attach_files', { sessionId: 'stdioparity1' });
    assert.ok(!/is not a function/.test(textOf(attach)), 'attach_files has a stdio op');

    // Model tools over stdio write the same server-wide store.
    const cfg = await call('warroom_get_model_config');
    assert.notEqual(cfg.isError, true, textOf(cfg));
    assert.match(textOf(cfg), /openai-api \(no credentials\)/, 'route availability comes from the server');

    const set = await call('warroom_set_model', { agentId: 'red-teamer', model: 'x-ai/grok-2', route: 'openrouter' });
    assert.notEqual(set.isError, true, textOf(set));
    const httpCfg = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.deepEqual(httpCfg.routing['red-teamer'], { route: 'openrouter', model: 'x-ai/grok-2' }, 'stdio write reached the shared store');

    // Read-modify-write: a second single-agent set must not wipe the first.
    await call('warroom_set_model', { agentId: 'divergent-generator', model: 'gpt-4o-mini' });
    const merged = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.deepEqual(merged.routing['red-teamer'], { route: 'openrouter', model: 'x-ai/grok-2' }, 'first override survives over stdio too');
    assert.deepEqual(merged.routing['divergent-generator'], { model: 'gpt-4o-mini' });

    // The same guard as the HTTP transport, enforced before the PUT.
    const bad = await call('warroom_set_model', { agentId: 'process-architect', route: 'openrouter' });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /non-default route requires an explicit model/);

    // Newly wired read tools answer over REST.
    assert.match(textOf(await call('warroom_list_presets')), /\[engineer\]/);
    assert.match(textOf(await call('warroom_get_phases')), /0\. Problem Framing/);
    assert.match(textOf(await call('warroom_get_session_agents', { sessionId: 'stdioparity1' })), /Core agents \(8\)/);

    // json export over stdio matches the HTTP export.
    const json = textOf(await call('warroom_export_session', { sessionId: 'stdioparity1', mode: 'end_result', format: 'json' }));
    const viaHttp = await (await fetch(`${server.baseUrl}/api/sessions/stdioparity1/export?mode=end_result&format=json`)).json();
    assert.deepEqual(JSON.parse(json), viaHttp);
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});

test('stdio transport authenticates when the deployment sets WAR_ROOM_TOKEN', async () => {
  // Without a bearer header every /api/* call 401s, so the stdio transport only
  // ever worked against an ungated server.
  const TOKEN = 'stdio-parity-bearer-token';
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'test-anthropic' } });
  const authed = new Client({ name: 'stdio-auth-test', version: '1.0.0' });
  const anon = new Client({ name: 'stdio-anon-test', version: '1.0.0' });
  try {
    await authed.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'mcp', 'stdio.mjs')],
      env: { ...process.env, WAR_ROOM_URL: server.baseUrl, WAR_ROOM_TOKEN: TOKEN },
    }));
    const ok = await authed.callTool({ name: 'warroom_get_phases', arguments: {} });
    assert.notEqual(ok.isError, true, textOf(ok));
    assert.match(textOf(ok), /Problem Framing/, 'token-carrying client reads the gated API');

    await anon.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'mcp', 'stdio.mjs')],
      env: { ...process.env, WAR_ROOM_URL: server.baseUrl, WAR_ROOM_TOKEN: '' },
    }));
    const denied = await anon.callTool({ name: 'warroom_get_phases', arguments: {} });
    assert.equal(denied.isError, true, 'no token means no access, and it says so');
    assert.match(textOf(denied), /401/);
  } finally {
    try { await authed.close(); } catch {}
    try { await anon.close(); } catch {}
    await server.dispose();
  }
});
