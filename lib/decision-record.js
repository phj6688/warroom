// HLB-794 / HLB-888 — build the verbatim Decision Record for a session: the
// Synthesis-phase verdict text, with NO LLM call. Shared by the HTTP route
// (GET /api/sessions/:id/decision-record) and the MCP tool
// (warroom_get_decision_record).
//
// Returns null when the session does not exist. Otherwise a plain object:
//   { sessionId, available:false, outcome }              for a failed or synthesis-less session
//   { sessionId, available:true, outcome, problem, verdict }  otherwise
function buildDecisionRecord(stmts, id) {
  const sessionRow = stmts.getSession.get(id);
  if (!sessionRow) return null;
  if (sessionRow.outcome === 'failed') return { sessionId: id, available: false, outcome: 'failed' };
  const synthesis = stmts.getSynthesisMessages.all(id);
  if (synthesis.length === 0) return { sessionId: id, available: false, outcome: sessionRow.outcome || null };
  const verdict = synthesis.map(m => m.content).join('\n\n');
  return { sessionId: id, available: true, outcome: sessionRow.outcome || 'complete', problem: sessionRow.problem, verdict };
}

module.exports = { buildDecisionRecord };
