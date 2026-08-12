// B7 (HLB-797) — classify a finished deliberation.
//
// The first version asked "did anything happen" (message count > 0), so a run
// killed at Problem Framing by a redeploy stored the same 'complete' as a run
// that reached Synthesis. Session 83be7536 on 2026-08-12 is the proof: three
// messages, phase 0 of 5, outcome 'complete', quality 0.249. A caller polling
// over MCP could not tell it from a genuine verdict.
//
// The question now is "did every phase run":
//   failed    the circuit breaker abandoned the run, or every turn errored
//             (a provider that refuses every turn is an infrastructure
//             failure, not a poor verdict)
//   stopped   the loop ended before the last phase — stop, delete, or SIGTERM
//   complete  every phase ran
//
// `deactivated` outranks the message count. A stop issued in the seconds
// before the first agent speaks (the room spends them on classification and
// memory retrieval) leaves zero messages, and calling that 'failed' both
// blames the provider for a human decision and overwrites the 'stopped' that
// the shutdown path had already stamped.
//
// A failed or stopped run must not be quality-scored: scoring it pollutes the
// metric with infrastructure failures and dresses a dead session up as a
// judged one.
function deliberationOutcome({ messageCount = 0, phasesCompleted = 0, totalPhases = 0, aborted = false, deactivated = false, verdictProduced = false } = {}) {
  if (aborted) return 'failed';
  // Every phase ran AND the room actually produced its verdict. Running the
  // last phase is not the same as finishing it: a single 429 on the synthesis
  // turn leaves a transcript with no verdict in it, and calling that complete
  // is how a verdict-less session came to carry a quality score. This is the
  // same rule migration 022 applies to the historical rows.
  //
  // A stop that lands during the final turn still counts: that turn runs to
  // completion and writes its message before the loop notices.
  if (totalPhases > 0 && phasesCompleted >= totalPhases && messageCount > 0 && verdictProduced) return 'complete';
  if (deactivated) return 'stopped';
  if (messageCount === 0) return 'failed';
  return 'stopped';
}

module.exports = { deliberationOutcome };
