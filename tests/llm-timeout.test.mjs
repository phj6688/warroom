// A provider that accepts a request and never answers used to park the agent
// turn, its phase, and the whole deliberation: nothing in the loop carried a
// deadline, so there was no bound on how long a session could sit silent.
// Measured on the 2026-08-12 run, a legitimate turn takes 60-300s, so a hung
// call looks exactly like a slow one and nothing would ever end it. Every LLM
// call now carries an AbortSignal, and a timeout fails the turn once instead
// of burning the retry budget on a dead connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');
appConfig.init({ getAllSettings: { all: () => [] } });
const { callAnthropic, callAnthropicWithTools, callLLMRaw } = require('./lib/llm');

let calls = 0;
let sawSignal = null;
// A gateway that accepts the request and never answers. Honors the signal the
// caller passes, which is the whole point of the fix.
global.fetch = async (url, init) => {
  calls++;
  sawSignal = init && init.signal ? 'present' : 'absent';
  return new Promise((_resolve, reject) => {
    if (init && init.signal) {
      init.signal.addEventListener('abort', () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    }
  });
};

(async () => {
  for (const [label, call] of [
    ['callAnthropic', () => callAnthropic('s', [{ role: 'user', content: 'x' }], 'agent-x', 50)],
    ['callAnthropicWithTools', () => callAnthropicWithTools('s', [{ role: 'user', content: 'x' }], 'agent-x', [], 50)],
    ['callLLMRaw', () => callLLMRaw({ system: 's', messages: [{ role: 'user', content: 'x' }], agentId: 'agent-x', maxTokens: 50 })],
  ]) {
    calls = 0;
    const t0 = Date.now();
    await assert.rejects(call(), /timed out/i, label + ' must reject with a timeout');
    const elapsed = Date.now() - t0;
    assert.equal(sawSignal, 'present', label + ' must pass an abort signal to fetch');
    // The point is that a hung call settles at all: without a deadline it never
    // does. The bound is deliberately loose because a loaded CI box fires a
    // 400ms timer late; "was it retried" is asserted exactly, below.
    assert.ok(elapsed < 20000, label + ' returned in ' + elapsed + 'ms, expected under 20000');
    assert.equal(calls, 1, label + ' must not retry a timeout, got ' + calls + ' calls');
  }
  console.log('llm-timeout assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('a hung provider request fails the turn instead of parking the session', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, {
    env: {
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'test-key',
      LLM_TIMEOUT_MS: '400',
    },
  });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /llm-timeout assertions passed/);
});
