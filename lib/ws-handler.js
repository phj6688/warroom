const { enrichSession } = require('./routes');

function setupWebSocket(wss, deps) {
  const { stmts, activeSessions, AGENTS, PHASES, createSession, loadSession, runDeliberation, runFollowUp, broadcast, specialist, getAgentsForSession } = deps;

  function enrichForWs(s) {
    const enriched = enrichSession(s, stmts);
    enriched.problem = enriched.problem.substring(0, 150);
    return enriched;
  }

  wss.on('connection', (ws) => {
    console.log('Client connected');

    const sessionList = stmts.getRecentSessions.all().map(s => enrichForWs(s));
    ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList }));
    ws.send(JSON.stringify({ type: 'agents', agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })) }));
    ws.send(JSON.stringify({ type: 'phases', phases: PHASES }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);

        switch (msg.type) {
          case 'new-session': {
            if (!msg.problem || !msg.problem.trim()) {
              ws.send(JSON.stringify({ type: 'error', message: 'Problem statement is required' }));
              break;
            }
            const session = createSession(msg.problem, msg.files || []);
            broadcast({
              type: 'session-created',
              session: {
                id: session.id, problem: session.problem,
                files: (session.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
                phase: session.phase, active: session.active, createdAt: session.createdAt
              }
            });
            runDeliberation(session).catch(err => {
              console.error('Deliberation error:', err);
              broadcast({ type: 'error', message: err.message, sessionId: session.id });
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
              broadcast({ type: 'escalation-answered', escalationId: esc.id, answer: msg.answer, sessionId: session.id });
            }
            break;
          }

          case 'join-session': {
            let session = activeSessions.get(msg.sessionId);
            if (!session) session = loadSession(msg.sessionId);
            if (session) {
              ws.send(JSON.stringify({
                type: 'session-state',
                session: {
                  id: session.id, problem: session.problem, phase: session.phase,
                  active: session.active, messages: session.messages,
                  escalations: session.escalations, humanMessages: session.humanMessages || [],
                  files: (session.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
                  agentStates: session.agentStates || {}, createdAt: session.createdAt
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
              broadcast({ type: 'human-message', ...hm, sessionId: msg.sessionId });
              if (isFollowUp && msg.content.trim()) {
                runFollowUp(msg.sessionId, session, msg.content).catch(err => {
                  console.error('Follow-up error:', err.message);
                  broadcast({ type: 'error', message: `Follow-up failed: ${err.message}`, sessionId: msg.sessionId });
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
              broadcast({ type: 'session-stopped', sessionId: session.id });
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
            if (!msg.sessionId) break;
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
            // Broadcast updated state
            const allAgents = getAgentsForSession(resumeSession);
            broadcast({ type: 'agents', agents: allAgents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: !!a.isSpecialist })) });
            broadcast({ type: 'session-resumed', sessionId: resumeSession.id, fromPhase: resumePhase });
            console.log(`▶️  Resuming session ${resumeSession.id} from phase ${resumePhase}`);
            runDeliberation(resumeSession, resumePhase).catch(err => {
              console.error('Resume deliberation error:', err);
              broadcast({ type: 'error', message: err.message, sessionId: resumeSession.id });
            });
            break;
          }

          case 'delete-session': {
            if (msg.sessionId) {
              stmts.deleteSession.run(msg.sessionId);
              activeSessions.delete(msg.sessionId);
              broadcast({ type: 'session-deleted', sessionId: msg.sessionId });
            }
            break;
          }
        }
      } catch (err) {
        console.error('WS message error:', err);
      }
    });

    ws.on('close', () => console.log('Client disconnected'));
  });
}

module.exports = { setupWebSocket };
