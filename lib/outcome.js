// B7 (HLB-797) — classify a finished deliberation.
//
// A run that produced no agent messages means every agent turn errored (for
// example a provider rate-limit / model_cooldown storm): that is a failure, not
// a completion. server.js pushes a message only on a successful turn, so a
// zero-message run is the unambiguous all-turns-failed case. A failed run must
// not be scored as quality (scoring it pollutes the metric with infrastructure
// failures).
function deliberationOutcome(messageCount) {
  return messageCount > 0 ? 'complete' : 'failed';
}

module.exports = { deliberationOutcome };
