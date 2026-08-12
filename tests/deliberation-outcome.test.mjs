// B7 (HLB-797) classified a finished run by message count alone, so ANY run
// that produced one message stored outcome='complete'. A session stopped at
// Problem Framing by a redeploy was therefore indistinguishable at the API
// from a run that reached Synthesis (session 83be7536, 2026-08-12: three
// messages, phase 0, outcome 'complete', quality 0.249).
//
// The outcome now answers "did every phase run", not "did anything happen":
//   failed    no agent produced a message, or the run was aborted
//   stopped   the loop ended before the last phase (stop, delete, shutdown)
//   complete  every phase ran
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { deliberationOutcome } = require('./lib/outcome.js');

// A run that produced nothing is a failure whatever else happened.
assert.equal(
  deliberationOutcome({ messageCount: 0, phasesCompleted: 5, totalPhases: 5 }),
  'failed', 'zero messages is a failed run');

// The regression this file exists for: partial progress is not completion.
assert.equal(
  deliberationOutcome({ messageCount: 3, phasesCompleted: 1, totalPhases: 5 }),
  'stopped', 'three messages in phase 1 of 5 is stopped, not complete');
assert.equal(
  deliberationOutcome({ messageCount: 1, phasesCompleted: 0, totalPhases: 5 }),
  'stopped', 'one message and no finished phase is stopped');

// A run the circuit breaker killed is a failure, not a partial success: it
// ended because the provider refused every turn.
assert.equal(
  deliberationOutcome({ messageCount: 4, phasesCompleted: 1, totalPhases: 5, aborted: true }),
  'failed', 'an aborted run is failed');

// Only a run that got through every phase claims completion.
assert.equal(
  deliberationOutcome({ messageCount: 14, phasesCompleted: 5, totalPhases: 5 }),
  'complete', 'every phase run is complete');
assert.equal(
  deliberationOutcome({ messageCount: 6, phasesCompleted: 6, totalPhases: 5 }),
  'complete', 'a loop-back that overshoots still counts as complete');

console.log('deliberation-outcome assertions passed');
`;

test('deliberationOutcome separates complete from stopped and failed', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /deliberation-outcome assertions passed/);
});
