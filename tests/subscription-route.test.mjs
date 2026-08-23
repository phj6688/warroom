// A deployment that runs entirely on a subscription gateway used to be told
// two false things about its own routes:
//
//   1. `subscription` reported "no credentials", because it looked only at
//      CLIPROXY_GATEWAY_URL/TOKEN, while the same gateway was already serving
//      every call through the default route.
//   2. `openai-api` reported available, because it paired the hardcoded
//      https://api.openai.com/v1 with OPENAI_API_KEY — which on a gateway
//      deployment holds the GATEWAY's bearer token, not an OpenAI key. Picking
//      that route in the panel or over MCP 401s on every call.
//
// routeCreds reads env at module load, so each case runs in its own child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { availableRoutes, resolveRoute, defaultRouteBilling, isSelfHostedGateway } = require('./lib/llm');
console.log(JSON.stringify({
  available: availableRoutes(),
  billing: defaultRouteBilling(),
  sub: (() => { const r = resolveRoute('red-teamer', undefined, { 'red-teamer': { route: 'subscription', model: 'claude-opus-5' } }); return { route: r.route, baseUrl: r.baseUrl || null }; })(),
  gatewayCheck: [isSelfHostedGateway('http://10.0.0.1:18789/v1'), isSelfHostedGateway('https://api.openai.com/v1'), isSelfHostedGateway('')],
}));
`;

async function probe(env) {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  const line = stdout.trim().split('\n').filter(l => l.startsWith('{')).pop();
  return JSON.parse(line);
}

test('a gateway deployment: subscription is available and openai-api is not', async () => {
  const r = await probe({
    OPENAI_BASE_URL: 'http://100.79.164.120:18789/v1',
    OPENAI_API_KEY: 'gateway-bearer-token',
    OPENAI_PLATFORM_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLIPROXY_GATEWAY_URL: '',
    CLIPROXY_GATEWAY_TOKEN: '',
  });
  assert.equal(r.available.subscription, true, 'the route named subscription works on a subscription deployment');
  assert.equal(r.available['openai-api'], false, 'a gateway bearer token is not an OpenAI platform key');
  assert.equal(r.billing, 'amortized', 'gateway traffic is a slice of a flat plan, not metered');
  // Pinning an agent to `subscription` resolves to the gateway rather than
  // silently falling back to the default route.
  assert.equal(r.sub.route, 'subscription');
  assert.equal(r.sub.baseUrl, 'http://100.79.164.120:18789/v1');
});

test('a real OpenAI deployment keeps metered billing and a working openai-api', async () => {
  const r = await probe({
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_API_KEY: 'sk-a-real-platform-key',
    OPENAI_PLATFORM_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLIPROXY_GATEWAY_URL: '',
    CLIPROXY_GATEWAY_TOKEN: '',
  });
  assert.equal(r.available['openai-api'], true, 'no gateway in play, so the key really is an OpenAI key');
  assert.equal(r.available.subscription, false, 'and there is no subscription gateway to point at');
  assert.equal(r.billing, 'published', 'metered endpoint stays metered');
});

test('an explicit platform key restores openai-api alongside a gateway', async () => {
  const r = await probe({
    OPENAI_BASE_URL: 'http://100.79.164.120:18789/v1',
    OPENAI_API_KEY: 'gateway-bearer-token',
    OPENAI_PLATFORM_API_KEY: 'sk-a-real-platform-key',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLIPROXY_GATEWAY_URL: '',
    CLIPROXY_GATEWAY_TOKEN: '',
  });
  assert.equal(r.available['openai-api'], true, 'a dedicated platform key is the only thing that belongs on api.openai.com');
  assert.equal(r.available.subscription, true, 'and the gateway still backs the subscription route');
});

test('a dedicated CLIPROXY pair still wins over the default endpoint', async () => {
  const r = await probe({
    OPENAI_BASE_URL: 'http://100.79.164.120:18789/v1',
    OPENAI_API_KEY: 'gateway-bearer-token',
    OPENAI_PLATFORM_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENROUTER_API_KEY: '',
    CLIPROXY_GATEWAY_URL: 'http://cliproxy.internal:18789/v1',
    CLIPROXY_GATEWAY_TOKEN: 'cliproxy-token',
  });
  assert.equal(r.sub.baseUrl, 'http://cliproxy.internal:18789/v1', 'the explicit pair is not overridden by the fallback');
});

test('isSelfHostedGateway recognises a gateway, the public API, and nothing', async () => {
  const r = await probe({ OPENAI_BASE_URL: '', OPENAI_API_KEY: '' });
  assert.deepEqual(r.gatewayCheck, [true, false, false]);
});
