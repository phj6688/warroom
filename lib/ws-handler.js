function setupWebSocket(wss, deps) {
  const { stmts, activeSessions, AGENTS, PHASES, createSession, loadSession, runDeliberation, runFollowUp, broadcast } = deps;

  wss.on('connection', (ws) => {
    console.log('Client connected');

    const sessionList = stmts.getRecentSessions.all().map(s => ({
      id: s.id, problem: s.problem.substring(0, 150), phase: s.phase,
      active: !!s.active, messageCount: stmts.countSessionMessages.get(s.id).count,
      createdAt: s.created_at
    }));
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
            const sessions = stmts.getRecentSessions.all().map(s => ({
              id: s.id, problem: s.problem.substring(0, 150), phase: s.phase,
              active: !!s.active, createdAt: s.created_at
            }));
            ws.send(JSON.stringify({ type: 'sessions', sessions }));
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
