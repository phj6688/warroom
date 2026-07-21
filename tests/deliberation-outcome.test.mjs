// B7 (HLB-797) — deliberationOutcome classifies a finished run. A zero-message
// run (every agent turn errored, e.g. a provider cooldown storm) is 'failed';
// anything that produced a message is 'complete'. The completion path uses this
// to persist the outcome and to skip quality scoring on a failed run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { deliberationOutcome } = require('./lib/outcome.js');
assert.equal(deliberationOutcome(0), 'failed', 'zero messages is a failed run');
assert.equal(deliberationOutcome(1), 'complete', 'one message is a completed run');
assert.equal(deliberationOutcome(14), 'complete', 'many messages is a completed run');
console.log('deliberation-outcome assertions passed');
`;

test('deliberationOutcome: zero messages -> failed, otherwise complete (HLB-797)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /deliberation-outcome assertions passed/);
});
