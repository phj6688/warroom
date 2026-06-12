// HLB-336 — per-agent provider routing. resolveRoute() must (a) reproduce the
// pre-existing default when an agent has no config, (b) honor a configured
// route+model, (c) fall back to the default (keeping the configured model) when
// a configured route has no credentials, and (d) accept a model-only override.
// Run in an isolated child process so the env that llm.js reads at module load
// is fully controlled and cannot be contaminated by sibling test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');
const { resolveRoute, availableRoutes } = require('./lib/llm');

const routing = {
  'divergent-generator': { route: 'openrouter', model: 'x-ai/grok-2' },
  'red-teamer': { route: 'subscription', model: 'claude-sonnet-4-6' },
  'quantitative-expert': { model: 'gpt-4o-mini' },
};
appConfig.init({ getAllSettings: { all: () => [{ key: 'agent_routing', value: JSON.stringify(routing) }] } });

// (a) Unconfigured agent: OPENAI_API_KEY empty + ANTHROPIC_API_KEY set => anthropic default.
const def = resolveRoute('process-architect');
assert.equal(def.transport, 'anthropic', 'default transport');
assert.equal(def.route, 'anthropic-api', 'default route');
assert.ok(def.model, 'default has a model');

// (b) Configured route with creds present.
const orr = resolveRoute('divergent-generator');
assert.equal(orr.route, 'openrouter');
assert.equal(orr.transport, 'openai');
assert.equal(orr.baseUrl, 'https://openrouter.ai/api/v1');
assert.equal(orr.model, 'x-ai/grok-2');

// (c) Configured route without creds => fall back to default, keep configured model.
const sub = resolveRoute('red-teamer');
assert.equal(sub.route, 'anthropic-api', 'missing-creds route falls back to default');
assert.equal(sub.model, 'claude-sonnet-4-6', 'configured model kept on fallback');

// (d) Model-only config => default route, configured model.
const mo = resolveRoute('quantitative-expert');
assert.equal(mo.route, 'anthropic-api');
assert.equal(mo.model, 'gpt-4o-mini');

// availableRoutes reflects which creds exist.
const avail = availableRoutes();
assert.equal(avail['openrouter'], true, 'openrouter available');
assert.equal(avail['subscription'], false, 'subscription unavailable (no cliproxy creds)');
assert.equal(avail['anthropic-api'], true, 'anthropic available');
assert.equal(avail['ollama-local'], true, 'ollama always available (local)');

console.log('agent-routing assertions passed');
`;

test('resolveRoute: defaults unchanged, configured routes honored, missing-creds falls back (HLB-336)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, {
    env: {
      ANTHROPIC_API_KEY: 'test-anthropic',
      OPENAI_API_KEY: '',
      OPENROUTER_API_KEY: 'test-or',
      CLIPROXY_GATEWAY_URL: '',
      CLIPROXY_GATEWAY_TOKEN: '',
    },
  });
  assert.equal(code, 0, `routing script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /agent-routing assertions passed/);
});
