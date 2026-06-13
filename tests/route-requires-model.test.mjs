// HLB-342 fix 1 — a non-default route with no model must never ship the global
// Anthropic model id to a non-Anthropic endpoint. resolveRoute() falls back to
// the default route (same handling as a route whose credentials are missing),
// and the PUT /api/settings/agent-routing handler rejects route-without-model.
// resolveRoute runs in an isolated child process so the env read at module load
// is fully controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript, spawnServer } from './_helpers.mjs';

// No OPENAI_* in the env, so the env default route is the Anthropic SDK. The
// agents' non-default route is ollama-local (always credentialed, so the test
// isolates model-presence from credential-presence): an Anthropic model id on
// that openai-shaped transport is the bug HLB-342 fixes.
const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');
const { resolveRoute } = require('./lib/llm');

const routing = {
  // Non-default route, no model: the failure mode HLB-342 fixes.
  'divergent-generator': { route: 'ollama-local' },
  // Non-default route WITH a model: must be honored unchanged.
  'red-teamer': { route: 'ollama-local', model: 'llama3.1:8b' },
};
appConfig.init({ getAllSettings: { all: () => [{ key: 'agent_routing', value: JSON.stringify(routing) }] } });

// Route without a model falls back to the anthropic default; the Anthropic
// model id never leaves on the openai transport.
const noModel = resolveRoute('divergent-generator');
assert.equal(noModel.transport, 'anthropic', 'route-without-model falls back to anthropic default transport');
assert.equal(noModel.route, 'anthropic-api', 'route-without-model falls back to default route');
assert.ok(noModel.model && noModel.model.startsWith('anthropic/'), 'default model is the anthropic default');
// Belt and suspenders: an openai-transport resolution must never carry an anthropic/ model.
assert.ok(!(noModel.transport === 'openai' && String(noModel.model).startsWith('anthropic/')), 'no anthropic id on an openai transport');

// Route WITH a model is honored: openai-shaped ollama transport, configured model.
const withModel = resolveRoute('red-teamer');
assert.equal(withModel.transport, 'openai', 'route+model keeps the ollama (openai-shaped) transport');
assert.equal(withModel.route, 'ollama-local');
assert.equal(withModel.model, 'llama3.1:8b', 'configured model is used verbatim');

// An explicit model (callLLMRaw override) also rescues a model-less route config.
const explicit = resolveRoute('divergent-generator', 'llama3.1:70b');
assert.equal(explicit.transport, 'openai', 'explicit model lets the configured route stand');
assert.equal(explicit.route, 'ollama-local');
assert.equal(explicit.model, 'llama3.1:70b');

console.log('route-requires-model assertions passed');
`;

test('resolveRoute: non-default route without a model falls back to default (HLB-342)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, {
    env: {
      ANTHROPIC_API_KEY: 'test-anthropic',
      OPENAI_API_KEY: '',
      OPENAI_BASE_URL: '',
    },
  });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /route-requires-model assertions passed/);
});

test('PUT /api/settings/agent-routing rejects a non-default route with no model (HLB-342)', async () => {
  const token = 'hlb342-route-validation';
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: token } });
  try {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // Pick a real agent id from the routing settings.
    const cfgRes = await fetch(`${server.baseUrl}/api/settings/agent-routing`, { headers });
    assert.equal(cfgRes.status, 200, 'settings readable');
    const cfg = await cfgRes.json();
    const agentId = cfg.agents[0].id;

    // route without model => 400.
    const bad = await fetch(`${server.baseUrl}/api/settings/agent-routing`, {
      method: 'PUT', headers,
      body: JSON.stringify({ routing: { [agentId]: { route: 'openai-api' } } }),
    });
    assert.equal(bad.status, 400, 'route-without-model is rejected');
    const badBody = await bad.json();
    assert.match(badBody.error, /model/i, 'error explains a model is required');

    // The default route never requires a model.
    const okDefault = await fetch(`${server.baseUrl}/api/settings/agent-routing`, {
      method: 'PUT', headers,
      body: JSON.stringify({ routing: { [agentId]: { model: 'gpt-4o-mini' } } }),
    });
    assert.equal(okDefault.status, 200, 'model-only (default route) is accepted');

    // route + model is accepted and persisted.
    const okBoth = await fetch(`${server.baseUrl}/api/settings/agent-routing`, {
      method: 'PUT', headers,
      body: JSON.stringify({ routing: { [agentId]: { route: 'openai-api', model: 'gpt-4o-mini' } } }),
    });
    assert.equal(okBoth.status, 200, 'route+model is accepted');
    const okBody = await okBoth.json();
    assert.equal(okBody.routing[agentId].route, 'openai-api');
    assert.equal(okBody.routing[agentId].model, 'gpt-4o-mini');
  } finally {
    await server.dispose();
  }
});
