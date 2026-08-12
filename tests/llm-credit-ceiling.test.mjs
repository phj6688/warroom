// OpenRouter reserves the model's full output ceiling against the credit
// balance when a request omits max_tokens, then refuses the whole request with
// 402 and names what the balance does cover:
//   "You requested up to 65536 tokens, but can only afford 20722."
// On 2026-08-11 that killed 21 of 21 agent turns across three sessions, which
// produced zero messages and cost real money. Ask again once for exactly what
// the balance covers instead of losing the turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');
appConfig.init({ getAllSettings: { all: () => [] } });
const { callAnthropic } = require('./lib/llm');

const bodies = [];
let mode = 'afford-then-ok';
global.fetch = async (url, init) => {
  bodies.push(JSON.parse(init.body));
  if (bodies.length === 1) {
    return {
      ok: false,
      status: 402,
      text: async () => JSON.stringify({ error: { message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 20722.', code: 402 } }),
    };
  }
  if (mode === 'always-402') {
    return { ok: false, status: 402, text: async () => 'still broke' };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: 'recovered answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
  };
};

(async () => {
  const text = await callAnthropic('s', [{ role: 'user', content: 'x' }], 'agent-x');
  assert.equal(text, 'recovered answer', 'the retry at the affordable budget must return content');
  assert.equal(bodies.length, 2, 'exactly one retry, got ' + bodies.length + ' requests');
  assert.equal(bodies[0].max_tokens, undefined, 'first request stays uncapped');
  assert.equal(bodies[1].max_tokens, 20722, 'retry asks for exactly what the balance covers');

  // A balance that cannot cover even the reduced ask must fail fast, not spin.
  bodies.length = 0;
  mode = 'always-402';
  await assert.rejects(
    callAnthropic('s', [{ role: 'user', content: 'x' }], 'agent-x'),
    /402/,
    'a genuinely empty balance still fails'
  );
  assert.equal(bodies.length, 2, 'no retry storm on a hard 402, got ' + bodies.length);
  console.log('llm-credit-ceiling assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('a 402 credit ceiling is retried once at the affordable budget, then fails fast', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, {
    env: { OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'test-key' },
  });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /llm-credit-ceiling assertions passed/);
});
