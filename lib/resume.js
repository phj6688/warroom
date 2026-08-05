'use strict';

// Shared resume core for the HTTP route and the MCP tool. ws-handler.js keeps
// its own copy: it additionally auto-subscribes the resuming socket and pushes
// its own session update, and rewriting the live socket path was not worth the
// regression risk. Keep the two in step if the resume rules change.

const { computeResumePhase } = require('./phases');

// Re-activate a stopped or orphaned session at its first unfinished phase and
// start the deliberation. Returns { error, status } instead of throwing so each
// transport can map the failure to its own shape.
function resumeSession(deps, sessionId) {
  const { stmts, AGENTS, PHASES, activeSessions, loadSession, runDeliberation, specialist, getAgentsForSession, broadcast, broadcastGlobal, log } = deps;

  if (activeSessions.has(sessionId)) return { error: 'Session is already running', status: 409 };
  const session = loadSession(sessionId);
  if (!session) return { error: 'Session not found', status: 404 };

  const resumePhase = computeResumePhase(session, PHASES);
  if (resumePhase >= PHASES.length) return { error: 'Session already complete (all phases covered)', status: 409 };

  session.phase = resumePhase;
  stmts.updateSessionPhase.run(resumePhase, Date.now(), session.id);
  session.active = true;
  stmts.updateSessionActive.run(1, Date.now(), session.id);

  const row = stmts.getSession.get(sessionId);
  if (row && row.specialist_agents && specialist) {
    try {
      const specIds = JSON.parse(row.specialist_agents);
      const domains = specIds
        .map(sid => { const t = stmts.getAgentTemplateById.get(sid); return t ? t.domain : null; })
        .filter(Boolean);
      if (domains.length) session._specialists = specialist.spawnSpecialists(domains);
    } catch (_) { /* invalid JSON, resume without specialists */ }
  }

  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  if (session._specialists) session._specialists.forEach(s => { session.agentStates[s.id] = 'idle'; });
  activeSessions.set(session.id, session);

  if (broadcastGlobal && getAgentsForSession) {
    const allAgents = getAgentsForSession(session);
    broadcastGlobal({ type: 'agents', agents: allAgents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: !!a.isSpecialist })) });
  }
  if (broadcast) broadcast(session.id, { type: 'session-resumed', sessionId: session.id, fromPhase: resumePhase });

  runDeliberation(session, resumePhase).catch(err => {
    if (log) log.error({ sessionId: session.id, err: err.message }, 'resume deliberation error');
  });

  return { session, resumePhase };
}

module.exports = { resumeSession };
