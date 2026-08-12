// B7 (HLB-797) — classify a finished deliberation.
//
// The first version asked "did anything happen" (message count > 0), so a run
// killed at Problem Framing by a redeploy stored the same 'complete' as a run
// that reached Synthesis. Session 83be7536 on 2026-08-12 is the proof: three
// messages, phase 0 of 5, outcome 'complete', quality 0.249. A caller polling
// over MCP could not tell it from a genuine verdict.
//
// The question now is "did every phase run":
//   failed    no agent produced a message, or the circuit breaker aborted the
//             run (a provider that refuses every turn is an infrastructure
//             failure, not a poor verdict)
//   stopped   the loop ended before the last phase — stop, delete, or SIGTERM
//   complete  every phase ran
//
// A failed or stopped run must not be quality-scored: scoring it pollutes the
// metric with infrastructure failures and dresses a dead session up as a
// judged one.
function deliberationOutcome({ messageCount = 0, phasesCompleted = 0, totalPhases = 0, aborted = false } = {}) {
  if (messageCount === 0 || aborted) return 'failed';
  if (phasesCompleted < totalPhases) return 'stopped';
  return 'complete';
}

module.exports = { deliberationOutcome };
