'use strict';

// Structured export shape, shared by GET /api/sessions/:id/export?format=json
// and the MCP export tool. Pure: takes a loadSession() object, returns data.
// The text/markdown builders stay in routes.js — the MCP transport has its own
// (differently formatted, separately tested) markdown path and merging the two
// would change bytes that callers already depend on.

function buildJsonExport(session, mode, createdAt, finishedAt, totalPhases) {
  const base = { sessionId: session.id, problem: session.problem, mode, createdAt, finishedAt, totalPhases };

  const synthesis = () => session.messages
    .filter(m => m.phase === 'Synthesis')
    .map(m => ({ agent: m.agentName, emoji: m.agentEmoji, content: m.content, timestamp: new Date(m.timestamp).toISOString() }));
  const questions = () => session.escalations
    .map(e => ({ askedBy: e.agentName, question: e.question, answer: e.answer || null, answered: e.answered }));
  const humanMessages = () => (session.humanMessages || [])
    .map(h => ({ content: h.content, timestamp: new Date(h.timestamp).toISOString() }));

  if (mode === 'full_transcript') {
    return {
      ...base,
      transcript: session.messages.map(m => ({ agent: m.agentName, emoji: m.agentEmoji, phase: m.phase, content: m.content, timestamp: new Date(m.timestamp).toISOString() })),
      questions: questions(),
      humanMessages: humanMessages(),
    };
  }
  if (mode === 'end_result') {
    return { ...base, synthesis: synthesis() };
  }
  if (mode === 'end_result_with_qa') {
    return { ...base, synthesis: synthesis(), questions: questions(), humanMessages: humanMessages() };
  }
  return base;
}

module.exports = { buildJsonExport };
