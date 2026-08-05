// MCP clients could not pick their models: the agent-routing store the Settings
// panel writes had no MCP surface at all. warroom_get_model_config /
// warroom_set_model / warroom_test_model close that, writing the same
// server-wide store, so a change through MCP is visible over HTTP and vice
// versa. Driven through a real MCP client against a spawned server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer } from './_helpers.mjs';

const MCP_KEY = 'mcp-test-key-modelsel000001';

async function connect(server) {
  const client = new Client({ name: 'model-selection-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`)));
  return client;
}

function textOf(res) {
  return (res.content || []).map(c => c.text || '').join('\n');
}

test('MCP model tools: read, set, merge, clear, and cross-transport agreement', async () => {
  const server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      MCP_API_KEY: MCP_KEY,
      ANTHROPIC_API_KEY: 'test-anthropic',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: 'test-openrouter',
    },
  });
  const client = await connect(server);
  try {
    const call = async (name, args = {}) => textOf(await client.callTool({ name, arguments: args }));

    // The three model tools are advertised.
    const tools = (await client.listTools()).tools.map(t => t.name);
    for (const t of ['warroom_get_model_config', 'warroom_set_model', 'warroom_test_model']) {
      assert.ok(tools.includes(t), `${t} is registered`);
    }

    // Read: every agent reports an effective model, and route availability is
    // reported honestly (openrouter has a key here, openai-api does not).
    const before = await call('warroom_get_model_config');
    assert.match(before, /red-teamer/, 'lists agents by id');
    assert.match(before, /openai-api \(no credentials\)/, 'flags routes without credentials');
    assert.ok(!/openrouter \(no credentials\)/.test(before), 'openrouter has credentials here');

    // Set one agent to a non-default route + model.
    const set = await call('warroom_set_model', { agentId: 'red-teamer', model: 'x-ai/grok-2', route: 'openrouter' });
    assert.match(set, /red-teamer: x-ai\/grok-2 via openrouter/, 'reports what it wrote');

    // The HTTP settings API sees the same store — one setting, two surfaces.
    const httpCfg = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.deepEqual(httpCfg.routing['red-teamer'], { route: 'openrouter', model: 'x-ai/grok-2' });
    assert.equal(httpCfg.effective['red-teamer'].model, 'x-ai/grok-2', 'agent resolves to the new model');

    // Setting a second agent must MERGE, not replace: the HTTP PUT takes the
    // whole map, so a naive per-agent write would wipe every other override.
    await call('warroom_set_model', { agentId: 'divergent-generator', model: 'gpt-4o-mini' });
    const merged = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.deepEqual(merged.routing['red-teamer'], { route: 'openrouter', model: 'x-ai/grok-2' }, 'first override survives');
    assert.deepEqual(merged.routing['divergent-generator'], { model: 'gpt-4o-mini' }, 'model-only override, default route');

    // A non-default route without a model would send the global Anthropic model
    // id to a non-Anthropic endpoint. Rejected, and nothing is persisted.
    const bad = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'process-architect', route: 'openrouter' } });
    assert.equal(bad.isError, true, 'route without model is an error');
    assert.match(textOf(bad), /non-default route requires an explicit model/);
    const afterBad = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.equal(afterBad.routing['process-architect'], undefined, 'rejected write did not persist');

    // Unknown route and unknown agent are rejected by name.
    const badRoute = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'm', route: 'not-a-route' } });
    assert.equal(badRoute.isError, true);
    assert.match(textOf(badRoute), /unknown route: not-a-route/);
    const badAgent = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'nope', model: 'm' } });
    assert.equal(badAgent.isError, true);
    assert.match(textOf(badAgent), /unknown agent: nope/);

    // "all" applies one pair across every agent.
    await call('warroom_set_model', { agentId: 'all', model: 'claude-opus-5' });
    const all = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.equal(all.agents.length > 1, true);
    for (const a of all.agents) {
      assert.equal(all.routing[a.id]?.model, 'claude-opus-5', `${a.id} took the apply-all model`);
    }

    // clear drops the override so the agent falls back to the server default.
    await call('warroom_set_model', { agentId: 'red-teamer', clear: true });
    const cleared = await (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    assert.equal(cleared.routing['red-teamer'], undefined, 'override removed');
    assert.ok(cleared.effective['red-teamer'].model, 'still resolves to the env default');

    // A bare call with nothing to do is a usage error, not a silent no-op.
    const empty = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer' } });
    assert.equal(empty.isError, true);
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});

test('warroom_test_model reports a provider failure as a verdict, not a tool error', async () => {
  const server = await spawnServer({
    env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: MCP_KEY, ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: '' },
  });
  const client = await connect(server);
  try {
    // A route with no credentials in this deployment is a reachability answer.
    const res = await client.callTool({ name: 'warroom_test_model', arguments: { route: 'openai-api', model: 'gpt-4o-mini' } });
    assert.notEqual(res.isError, true, 'a provider verdict is not a tool failure');
    assert.match(textOf(res), /FAILED/, 'reports the failure');
    assert.match(textOf(res), /credentials/, 'says why');

    // A non-default route with no model is a usage error, before any network call.
    const bad = await client.callTool({ name: 'warroom_test_model', arguments: { route: 'openrouter' } });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /non-default route requires an explicit model/);
  } finally {
    try { await client.close(); } catch {}
    await server.dispose();
  }
});
