const { WebSocket } = require('ws');
const { enrichSession } = require('./routes');
const { validateWS } = require('./validation');
const { log, withSession } = require('./logger');
const { resolveEscalation, abortSessionWaits } = require('./escalation');

function setupWebSocket(wss, deps) {
  const {
    stmts, activeSessions, AGENTS, PHASES,
    createSession, loadSession, runDeliberation, runFollowUp,
    broadcast, broadcastGlobal, specialist, getAgentsForSession,
  } = deps;

  function enrichForWs(s) {
    const enriched = enrichSession(s, stmts);
    enriched.problem = enriched.problem.substring(0, 150);
    return enriched;
  }

  function sendInvalid(ws, detail) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'error', code: 'INVALID_MSG', detail }));
  }

  wss.on('connection', (ws) => {
    log.debug('client connected');
    // F2 — every client maintains its own subscription set. broadcasts tagged
    // with a sessionId only reach clients with that sessionId in this set.
    ws.subscribedSessions = new Set();

    const sessionList = stmts.getRecentSessions.all().map(s => enrichForWs(s));
    ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList }));
    ws.send(JSON.stringify({ type: 'agents', agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })) }));
    ws.send(JSON.stringify({ type: 'phases', phases: PHASES }));

    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (err) {
        return sendInvalid(ws, 'malformed JSON');
      }

      // F5 — gate every WS message through zod before any handler logic runs.
      const v = validateWS(msg);
      if (!v.ok) return sendInvalid(ws, v.error);
      msg = v.data;

      try {
        switch (msg.type) {
          case 'subscribe': {
            ws.subscribedSessions.add(msg.sessionId);
            break;
          }

          case 'unsubscribe': {
            ws.subscribedSessions.delete(msg.sessionId);
            break;
          }

          case 'new-session': {
            const session = createSession(msg.problem, msg.files || []);
            // Auto-subscribe the originating client so it receives the
            // session-created and subsequent deliberation events.
            ws.subscribedSessions.add(session.id);
            broadcast(session.id, {
              type: 'session-created',
              session: {
                id: session.id, problem: session.problem,
                files: (session.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
                phase: session.phase, active: session.active, createdAt: session.createdAt
              }
            });
            runDeliberation(session).catch(err => {
              withSession(session.id).error({ err: err.message }, 'deliberation error');
              broadcast(session.id, { type: 'error', message: err.message, sessionId: session.id });
            });
            break;
          }

          case 'escalation-response': {
            const session = activeSessions.get(msg.sessionId);
            if (!session) break;
            const esc = session.escalations.find(e => e.id === msg.escalationId);
            if (esc) {
              esc.answered = true;
              esc.answer = msg.answer;
              stmts.answerEscalation.run(msg.answer, Date.now(), msg.escalationId);
              broadcast(session.id, { type: 'escalation-answered', escalationId: esc.id, answer: msg.answer, sessionId: session.id });
              // F13 — wake the deliberation immediately. The waiter (in
              // server.js runDeliberation) is parked on a Promise keyed by
              // (sessionId, escalationId) and resumes the moment we resolve.
              resolveEscalation(session.id, esc.id, msg.answer);
            }
            break;
          }

          case 'join-session': {
            let session = activeSessions.get(msg.sessionId);
            if (!session) session = loadSession(msg.sessionId);
            if (session) {
              // Auto-subscribe on join so the client immediately receives
              // any session-tagged broadcasts that follow.
              ws.subscribedSessions.add(msg.sessionId);
              ws.send(JSON.stringify({
                type: 'session-state',
                session: {
                  id: session.id, problem: session.problem, phase: session.phase,
                  active: session.active, messages: session.messages,
                  escalations: session.escalations, humanMessages: session.humanMessages || [],
                  files: (session.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
                  agentStates: session.agentStates || {}, createdAt: session.createdAt,
                  archetypeId: session.archetypeId ?? null,
                  qualityScore: session.qualityScore ?? null,
                  pinned: !!session.pinned,
                  specialistAgents: session.specialistAgents || [],
                }
              }));
            }
            break;
          }

          case 'human-message': {
            let session = activeSessions.get(msg.sessionId);
            const isFollowUp = !session || !session.active;
            if (!session) session = loadSession(msg.sessionId);
            if (session) {
              const now = Date.now();
              const hmId = require('crypto').randomUUID();
              const hm = { id: hmId, content: msg.content, timestamp: now };
              if (session.humanMessages) session.humanMessages.push(hm);
              stmts.insertHumanMessage.run(hmId, msg.sessionId, msg.content, now);
              broadcast(msg.sessionId, { type: 'human-message', ...hm, sessionId: msg.sessionId });
              if (isFollowUp && msg.content.trim()) {
                runFollowUp(msg.sessionId, session, msg.content).catch(err => {
                  withSession(msg.sessionId).error({ err: err.message }, 'follow-up error');
                  broadcast(msg.sessionId, { type: 'error', message: `Follow-up failed: ${err.message}`, sessionId: msg.sessionId });
                });
              }
            }
            break;
          }

          case 'stop-session': {
            const session = activeSessions.get(msg.sessionId);
            if (session) {
              session.active = false;
              stmts.updateSessionActive.run(0, Date.now(), session.id);
              activeSessions.delete(session.id);
              // F13 — release any deliberation parked on an escalation wait
              // for this session so the loop can fall through and exit.
              abortSessionWaits(session.id, 'session stopped');
              broadcast(session.id, { type: 'session-stopped', sessionId: session.id });
            }
            break;
          }

          case 'get-sessions': {
            const sessions = stmts.getRecentSessions.all().map(s => enrichForWs(s));
            ws.send(JSON.stringify({ type: 'sessions', sessions }));
            break;
          }

          case 'resume-session': {
            // Resume an orphaned session (marked active in DB but no running process)
            if (activeSessions.has(msg.sessionId)) {
              ws.send(JSON.stringify({ type: 'error', message: 'Session is already running', sessionId: msg.sessionId }));
              break;
            }
            const resumeSession = loadSession(msg.sessionId);
            if (!resumeSession) {
              ws.send(JSON.stringify({ type: 'error', message: 'Session not found', sessionId: msg.sessionId }));
              break;
            }
            const resumePhase = resumeSession.phase || 0;
            // Re-activate
            resumeSession.active = true;
            stmts.updateSessionActive.run(1, Date.now(), resumeSession.id);
            // Reconstruct specialists from DB
            const specRow = stmts.getSession.get(resumeSession.id);
            if (specRow && specRow.specialist_agents) {
              try {
                const specIds = JSON.parse(specRow.specialist_agents);
                if (specIds.length > 0) {
                  const domains = specIds.map(id => {
                    const tpl = stmts.getAgentTemplateById ? stmts.getAgentTemplateById.get(id) : null;
                    return tpl ? tpl.domain : null;
                  }).filter(Boolean);
                  if (domains.length > 0) {
                    resumeSession._specialists = specialist.spawnSpecialists(domains);
                  }
                }
              } catch (_) {}
            }
            // Initialize agent states
            AGENTS.forEach(a => { resumeSession.agentStates[a.id] = 'idle'; });
            if (resumeSession._specialists) {
              resumeSession._specialists.forEach(s => { resumeSession.agentStates[s.id] = 'idle'; });
            }
            activeSessions.set(resumeSession.id, resumeSession);
            // Auto-subscribe the resuming client.
            ws.subscribedSessions.add(resumeSession.id);
            // Broadcast updated state
            const allAgents = getAgentsForSession(resumeSession);
            broadcastGlobal({ type: 'agents', agents: allAgents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: !!a.isSpecialist })) });
            broadcast(resumeSession.id, { type: 'session-resumed', sessionId: resumeSession.id, fromPhase: resumePhase });
            withSession(resumeSession.id).info({ fromPhase: resumePhase }, 'resuming session');
            runDeliberation(resumeSession, resumePhase).catch(err => {
              withSession(resumeSession.id).error({ err: err.message }, 'resume deliberation error');
              broadcast(resumeSession.id, { type: 'error', message: err.message, sessionId: resumeSession.id });
            });
            break;
          }

          case 'delete-session': {
            stmts.deleteSession.run(msg.sessionId);
            activeSessions.delete(msg.sessionId);
            broadcast(msg.sessionId, { type: 'session-deleted', sessionId: msg.sessionId });
            break;
          }
        }
      } catch (err) {
        log.error({ err: err.message, type: msg && msg.type }, 'ws message error');
      }
    });

    ws.on('close', () => log.debug('client disconnected'));
  });
}

module.exports = { setupWebSocket };
