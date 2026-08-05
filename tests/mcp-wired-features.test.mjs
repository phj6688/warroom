// Features that existed over HTTP/WS but had no MCP surface: role presets,
// session continuation, resume, the quality rating + score, semantic recall,
// the problem-statement improver, the specialist roster, phases, and a
// structured export. Driven through a real MCP client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-wiredfeat00001';

function textOf(res) {
  return (res.content || []).map(c => c.text || '').join('\n');
}

async function withClient(server, fn) {
  const client = new Client({ name: 'wired-features-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`)));
  try { return await fn(client); } finally { try { await client.close(); } catch {} }
}

test('MCP exposes presets, phases, specialists and a structured export', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)')
      .run('wiredfeat01', 'structured export me', now, now);
    db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('wm1', 'wiredfeat01', 'process-architect', 'Process Architect', '', '', 'THE-VERDICT', 'Synthesis', now);
    db.close();

    await withClient(server, async (client) => {
      const call = async (name, args = {}) => textOf(await client.callTool({ name, arguments: args }));

      const presets = await call('warroom_list_presets');
      assert.match(presets, /\[engineer\]/, 'engineer preset listed');
      assert.match(presets, /\[scientist\]/, 'scientist preset listed');

      const phases = await call('warroom_get_phases');
      assert.match(phases, /0\. Problem Framing/, 'phase order is readable');
      assert.match(phases, /4\. Synthesis/);

      const specialists = await call('warroom_list_specialists');
      assert.ok(specialists.length > 0, 'specialist roster answers');

      const roster = await call('warroom_get_session_agents', { sessionId: 'wiredfeat01' });
      assert.match(roster, /Core agents \(8\)/, 'the 8 core agents');
      assert.match(roster, /Specialists: none/, 'no specialists on a seeded session');

      // json export must be parseable and carry the same shape as the HTTP one.
      const json = await call('warroom_export_session', { sessionId: 'wiredfeat01', mode: 'end_result', format: 'json' });
      const parsed = JSON.parse(json);
      assert.equal(parsed.sessionId, 'wiredfeat01');
      assert.equal(parsed.mode, 'end_result');
      assert.equal(parsed.synthesis[0].content, 'THE-VERDICT');
      const viaHttp = await (await fetch(`${server.baseUrl}/api/sessions/wiredfeat01/export?mode=end_result&format=json`)).json();
      assert.deepEqual(parsed, viaHttp, 'MCP json export matches the HTTP export byte for byte');

      // Markdown stays the default and unchanged.
      const md = await call('warroom_export_session', { sessionId: 'wiredfeat01' });
      assert.match(md, /## Deliberation/, 'default export is still the markdown transcript');
    });
  } finally {
    await server.dispose();
  }
});

test('MCP rating and quality read-back; unknown session is an error', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, shadow_answer) VALUES (?, ?, 4, 0, ?, ?, ?)')
      .run('wiredrate01', 'rate me', now, now, 'NAIVE-BASELINE-ANSWER');
    db.close();

    await withClient(server, async (client) => {
      const rated = await client.callTool({ name: 'warroom_rate_session', arguments: { sessionId: 'wiredrate01', rating: 'USEFUL' } });
      assert.notEqual(rated.isError, true);
      assert.match(textOf(rated), /rated USEFUL/);

      // The rating landed in the same column the web UI writes.
      const db2 = new Database(server.dbPath, { readonly: true });
      const row = db2.prepare('SELECT synthesis_quality FROM sessions WHERE id = ?').get('wiredrate01');
      db2.close();
      assert.equal(row.synthesis_quality, 'USEFUL');

      const q = textOf(await client.callTool({ name: 'warroom_get_quality', arguments: { sessionId: 'wiredrate01' } }));
      assert.match(q, /Human rating: USEFUL/, 'reads the rating back');
      assert.match(q, /not scored yet/, 'unscored session says so rather than faking a score');
      assert.match(q, /NAIVE-BASELINE-ANSWER/, 'surfaces the shadow baseline');

      const missing = await client.callTool({ name: 'warroom_get_quality', arguments: { sessionId: 'nosuchsession' } });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /not found/);

      // Analytics answers honestly with nothing scored.
      const analytics = textOf(await client.callTool({ name: 'warroom_get_analytics', arguments: {} }));
      assert.match(analytics, /No scored sessions yet/);
    });
  } finally {
    await server.dispose();
  }
});

test('warroom_create_session forwards presetId and continuesFromSessionId, and rejects bad ones', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)')
      .run('wiredprior1', 'the prior decision', now, now);
    db.close();

    await withClient(server, async (client) => {
      const created = await client.callTool({
        name: 'warroom_create_session',
        arguments: { problem: 'follow-up decision', presetId: 'engineer', continuesFromSessionId: 'wiredprior1' },
      });
      assert.notEqual(created.isError, true, textOf(created));
      const out = textOf(created);
      assert.match(out, /Preset: engineer/);
      assert.match(out, /Continues from: wiredprior1/);
      const id = out.match(/Session created: (\S+)/)[1];

      const db2 = new Database(server.dbPath, { readonly: true });
      const row = db2.prepare('SELECT preset_id, continues_from_session_id FROM sessions WHERE id = ?').get(id);
      db2.close();
      assert.equal(row.preset_id, 'engineer', 'preset persisted');
      assert.equal(row.continues_from_session_id, 'wiredprior1', 'continuation link persisted');

      // A typo must not silently degrade to a generalist run.
      const badPreset = await client.callTool({ name: 'warroom_create_session', arguments: { problem: 'x', presetId: 'enginer' } });
      assert.equal(badPreset.isError, true);
      assert.match(textOf(badPreset), /unknown preset: enginer/);

      const badPrior = await client.callTool({ name: 'warroom_create_session', arguments: { problem: 'x', continuesFromSessionId: 'nope' } });
      assert.equal(badPrior.isError, true);
      assert.match(textOf(badPrior), /prior session nope not found/);
    });
  } finally {
    await server.dispose();
  }
});

test('warroom_resume_session continues at the first unfinished phase and refuses a finished one', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    const insM = db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // Framing complete (all three of its agents spoke), the rest untouched.
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)')
      .run('wiredres01', 'resume me', now, now);
    for (const [i, agent] of [['process-architect', 'Process Architect'], ['research-scout', 'Research Scout'], ['systems-synthesizer', 'Systems Synthesizer']].entries()) {
      insM.run(`wr${i}`, 'wiredres01', agent[0], agent[1], '', '', 'framing done', 'Problem Framing', now + i);
    }
    // A session with every phase covered has nothing to resume.
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)')
      .run('wireddone1', 'already done', now, now);
    db.close();

    await withClient(server, async (client) => {
      const resumed = await client.callTool({ name: 'warroom_resume_session', arguments: { sessionId: 'wiredres01' } });
      assert.notEqual(resumed.isError, true, textOf(resumed));
      assert.match(textOf(resumed), /resumed from phase 1/, 'skips the completed framing phase');

      // Already running now — a second resume must refuse.
      const again = await client.callTool({ name: 'warroom_resume_session', arguments: { sessionId: 'wiredres01' } });
      assert.equal(again.isError, true);
      assert.match(textOf(again), /already running/);

      const missing = await client.callTool({ name: 'warroom_resume_session', arguments: { sessionId: 'nosuchsession' } });
      assert.equal(missing.isError, true);
      assert.match(textOf(missing), /not found/);
    });
  } finally {
    await server.dispose();
  }
});

test('semantic search says the backend is down instead of returning an empty result set', async () => {
  // No reachable embedding backend: an empty list would read as "nothing
  // similar", which is a different and wrong answer.
  const server = await spawnServer({
    env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY, OLLAMA_BASE_URL: 'http://127.0.0.1:1/v1', EMBEDDING_BASE_URL: 'http://127.0.0.1:1' },
  });
  try {
    await withClient(server, async (client) => {
      const res = await client.callTool({ name: 'warroom_semantic_search', arguments: { query: 'anything at all' } });
      assert.equal(res.isError, true, 'an unavailable backend is an error, not an empty result');
      assert.match(textOf(res), /warroom_search_sessions/, 'names the keyword fallback');
    });
  } finally {
    await server.dispose();
  }
});

test('every registered MCP tool resolves to an implemented op', async () => {
  // Both transports register the same tool list from one ops interface. A tool
  // whose op is missing used to fail with "ops.X is not a function" at call
  // time; nothing caught it at registration.
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY } });
  try {
    await withClient(server, async (client) => {
      const tools = (await client.listTools()).tools;
      assert.ok(tools.length >= 27, `expected the full tool set, got ${tools.length}`);
      for (const t of tools) {
        assert.match(t.name, /^warroom_/, 'tools are namespaced');
        assert.ok(t.description && t.description.length > 20, `${t.name} has a usable description`);
      }
      // No-argument read tools must answer rather than throw a TypeError.
      for (const name of ['warroom_get_model_config', 'warroom_list_presets', 'warroom_get_phases', 'warroom_list_specialists', 'warroom_list_agents', 'warroom_get_status', 'warroom_get_analytics']) {
        const res = await client.callTool({ name, arguments: {} });
        assert.notEqual(res.isError, true, `${name} answered: ${textOf(res)}`);
        assert.ok(!/is not a function/.test(textOf(res)), `${name} has an implemented op`);
      }
    });
  } finally {
    await server.dispose();
  }
});
