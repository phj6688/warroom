// HLB-820 — the LLM retry path must discriminate error classes and honor the
// 429 cooldown reset instead of blindly retrying three times. Before this fix,
// a provider `model_cooldown` (reset_seconds 60-126s) got three 1-4s retries
// that never cleared it, and a bad-request/auth 4xx was retried identically —
// on 2026-07-18 that amplified a cooldown into 333 log lines in 120 minutes.
//
// resolveRoute/callAnthropic run in an isolated child process (env read at
// module load), with global.fetch stubbed to force each error class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');
appConfig.init({ getAllSettings: { all: () => [] } });
const { callAnthropic } = require('./lib/llm');

let calls = 0;
function stub(status, body) {
  calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status, text: async () => body }; };
}
const call = () => callAnthropic('s', [{ role: 'user', content: 'x' }], 'agent-x', 50);

(async () => {
  // 401: a non-retryable client error must fail on the first attempt.
  stub(401, 'unauthorized');
  await assert.rejects(call);
  assert.equal(calls, 1, '401 must not be retried, got ' + calls);

  // 429 with a short reset_seconds: wait once, then one more attempt (<= 2).
  stub(429, JSON.stringify({ error: { code: 'model_cooldown', reset_seconds: 1 } }));
  await assert.rejects(call);
  assert.ok(calls >= 1 && calls <= 2, '429 with reset waits at most once, got ' + calls);

  // 429 rate_limit_error with no reset: fail fast, no retry storm.
  stub(429, JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }));
  await assert.rejects(call);
  assert.equal(calls, 1, '429 without reset_seconds fails fast, got ' + calls);

  // 5xx: the existing bounded backoff still retries up to MAX_RETRIES.
  stub(500, 'server error');
  await assert.rejects(call);
  assert.equal(calls, 3, '5xx retries up to MAX_RETRIES, got ' + calls);

  console.log('retry-error-class assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('retry: discriminate 4xx, honor 429 reset, keep 5xx backoff (HLB-820)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, {
    env: {
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
      ANTHROPIC_API_KEY: 'test-anthropic',
    },
  });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /retry-error-class assertions passed/);
});
