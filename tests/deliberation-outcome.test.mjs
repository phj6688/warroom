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

// ...unless a human stopped it before the first agent spoke. The room spends
// its first seconds on classification and memory retrieval, so a stop in that
// window leaves zero messages, and blaming the provider for a human decision
// also overwrites the 'stopped' the shutdown path already stamped.
assert.equal(
  deliberationOutcome({ messageCount: 0, phasesCompleted: 0, totalPhases: 5, deactivated: true }),
  'stopped', 'a stop before the first message is stopped, not failed');

// A stop landing during the final synthesis turn still leaves a finished
// deliberation: the turn ran to completion and wrote its verdict.
assert.equal(
  deliberationOutcome({ messageCount: 14, phasesCompleted: 5, totalPhases: 5, deactivated: true, verdictProduced: true }),
  'complete', 'all phases run counts as complete even if a stop arrived at the end');

// Reaching the last phase is not finishing it. One 429 on the synthesis turn
// leaves a transcript with no verdict in it, and calling that complete is how
// a verdict-less session came to carry a quality score.
assert.equal(
  deliberationOutcome({ messageCount: 14, phasesCompleted: 5, totalPhases: 5, verdictProduced: false }),
  'stopped', 'every phase run but no verdict produced is not a completion');

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
  deliberationOutcome({ messageCount: 14, phasesCompleted: 5, totalPhases: 5, verdictProduced: true }),
  'complete', 'every phase run with a verdict is complete');
assert.equal(
  deliberationOutcome({ messageCount: 6, phasesCompleted: 6, totalPhases: 5, verdictProduced: true }),
  'complete', 'a loop-back that overshoots still counts as complete');

console.log('deliberation-outcome assertions passed');
`;

test('deliberationOutcome separates complete from stopped and failed', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /deliberation-outcome assertions passed/);
});
