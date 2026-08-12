const { WebSocket } = require('ws');
const { enrichSession } = require('./routes');
const { validateWS } = require('./validation');
const { log, withSession } = require('./logger');
const { resolveEscalation, abortSessionWaits, pauseEscalation, resumeEscalation, resetEscalation, getDeadline, answerEscalationById, DEFAULT_TIMEOUT_MS } = require('./escalation');
const { computeResumePhase } = require('./phases');

function setupWebSocket(wss, deps) {
  const {
    stmts, activeSessions, AGENTS, PHASES,
    createSession, loadSession, runDeliberation, runFollowUp,
    broadcast, broadcastGlobal, specialist, getAgentsForSession,
    escalationTiming,
  } = deps;

  function enrichForWs(s) {
    const enriched = enrichSession(s, stmts);
    enriched.problem = enriched.problem.substring(0, 150);
    return enriched;
  }

  // Re-enrich a single session row and push it globally so every connected
  // client's local sessionsList stays in sync without a full reload.
  function pushSessionUpdate(sessionId) {
    try {
      const row = stmts.getRecentSessions.all().find(r => r.id === sessionId);
      if (!row) return;
      broadcastGlobal({ type: 'session-updated', session: enrichSession(row, stmts) });
    } catch (err) {
      log.warn({ sessionId, err: err.message }, 'pushSessionUpdate failed');
    }
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
            try {
              const session = await createSession(msg.problem, msg.file_ids || [], msg.preset_id || null, msg.continuesFromSessionId || null);
              ws.subscribedSessions.add(session.id);
              broadcast(session.id, {
                type: 'session-created',
                session: {
                  id: session.id, problem: session.problem,
                  phase: session.phase, active: session.active, createdAt: session.createdAt
                }
              });
              runDeliberation(session).catch(err => {
                withSession(session.id).error({ err: err.message }, 'deliberation error');
                broadcast(session.id, { type: 'error', message: err.message, sessionId: session.id });
              });
            } catch (err) {
              ws.send(JSON.stringify({ type: 'error', message: err.message }));
            }
            break;
          }

          case 'escalation-response': {
            // Shared with the MCP transport (lib/escalation answerEscalationById):
            // persist, update the live session, wake the deliberation parked on
            // this question, and tell the clients. An escalation from a session
            // that is no longer running is still answered and still recorded;
            // there is simply no waiter to release.
            answerEscalationById({ stmts, activeSessions, broadcast }, msg.escalationId, msg.answer);
            break;
          }

          case 'escalation-bulk-resolve': {
            // Bulk "ACCEPT N DEFAULTS · PROCEED" — resolve every still-open
            // escalation to its stated default in one action. Releases any
            // blocking waiters so the deliberation continues immediately.
            let session = activeSessions.get(msg.sessionId);
            if (!session) session = loadSession(msg.sessionId);
            if (!session) break;
            const open = session.escalations.filter(e => !e.answered);
            for (const esc of open) {
              const ans = esc.defaultAction
                ? `[accepted default] ${esc.defaultAction}`
                : '[accepted default] Proceed with your stated default / best judgment.';
              esc.answered = true;
              esc.answer = ans;
              stmts.answerEscalationBulk.run(ans, Date.now(), esc.id);
              broadcast(session.id, { type: 'escalation-answered', escalationId: esc.id, answer: ans, sessionId: session.id, bulkResolved: true });
              resolveEscalation(session.id, esc.id, ans);
            }
            break;
          }

          case 'escalation-timer': {
            // HLB-148: the human controls the countdown from the card. `pause`
            // suspends the auto-resolve deadline so the deliberation holds;
            // `resume` continues from the time left at pause; `reset` restarts a
            // fresh full window. The live blocking wait (when one is parked) is
            // the source of truth, so we mutate it via the escalation module; we
            // also mirror the state onto the in-memory escalation so the
            // broadcast and any wait that starts LATER honor it.
            let session = activeSessions.get(msg.sessionId);
            if (!session) {
              session = loadSession(msg.sessionId);
              // Keep an ACTIVE session that was loaded fresh (not yet cached,
              // e.g. crash-recovery, or a client driving the timer before the
              // deliberation re-parked its wait) in activeSessions, so the
              // remaining-time mirror set on pause survives the next op (resume).
              // Without this, each op reloads a fresh object and resume loses the
              // snapshot, silently restarting the full window. Production active
              // sessions are already cached, so this is a no-op there.
              if (session && session.active) activeSessions.set(session.id, session);
            }
            if (!session) break;
            const esc = session.escalations.find(e => e.id === msg.escalationId);
            if (!esc || esc.answered) break;
            if (msg.op === 'pause') {
              // Freeze the displayed deadline, and snapshot the time left so a
              // later resume (mirror path, when no live waiter is parked) can
              // continue from it rather than restart.
              if (typeof esc.deadlineAt !== 'number') {
                const t = escalationTiming ? escalationTiming(esc, session.active !== false) : getDeadline(session.id, esc.id);
                if (t) esc.deadlineAt = t.deadlineAt;
              }
              if (esc.paused !== true && typeof esc.deadlineAt === 'number') {
                esc.remainingMs = Math.max(0, esc.deadlineAt - Date.now());
              }
              pauseEscalation(session.id, esc.id);
              esc.paused = true;
            } else if (msg.op === 'resume') {
              resumeEscalation(session.id, esc.id);
              esc.paused = false;
              // Prefer the live waiter's resumed deadline (authoritative). With
              // no parked waiter, continue from the remaining snapshot taken at
              // pause, NOT a fresh full window (that is reset).
              const live = getDeadline(session.id, esc.id);
              if (live) {
                esc.deadlineAt = live.deadlineAt;
              } else {
                const remaining = typeof esc.remainingMs === 'number' ? esc.remainingMs : DEFAULT_TIMEOUT_MS;
                esc.deadlineAt = Date.now() + remaining;
              }
              esc.remainingMs = undefined;
            } else { // 'reset'
              resetEscalation(session.id, esc.id);
              esc.paused = false;
              esc.remainingMs = undefined;
              // Prefer the live waiter's restarted deadline; otherwise restart
              // the full window from now (a wait that starts later inherits it).
              const live = getDeadline(session.id, esc.id);
              esc.deadlineAt = live ? live.deadlineAt : Date.now() + DEFAULT_TIMEOUT_MS;
            }
            broadcast(session.id, {
              type: 'escalation-timer-updated',
              sessionId: session.id,
              escalationId: esc.id,
              paused: esc.paused,
              deadlineAt: esc.deadlineAt ?? null,
            });
            break;
          }

          case 'join-session': {
            let session = activeSessions.get(msg.sessionId);
            if (!session) session = loadSession(msg.sessionId);
            if (session) {
              // Auto-subscribe on join so the client immediately receives
              // any session-tagged broadcasts that follow.
              ws.subscribedSessions.add(msg.sessionId);
              // HLB-335 — surface the persisted per-session token total + breakdown
              // so reopening a completed session renders its usage. Active sessions
              // layer live token-tick events on top of this initial (possibly stale) row.
              const _tokRow = stmts.getSession.get(session.id);
              ws.send(JSON.stringify({
                type: 'session-state',
                session: {
                  id: session.id, problem: session.problem, phase: session.phase,
                  active: session.active, messages: session.messages,
                  // HLB-148: decorate each escalation with its countdown timing
                  // (deadlineAt + paused) so a client joining mid-flight renders
                  // the live countdown. loadSession already decorates; an active
                  // in-memory session's raw objects get it here.
                  escalations: (session.escalations || []).map(e => (escalationTiming ? { ...e, ...escalationTiming(e, session.active !== false) } : e)),
                  humanMessages: session.humanMessages || [],
                  files: (session.files || []).map(f => ({ file_id: f.file_id, file_name: f.file_name, file_mime: f.file_mime, file_tokens: f.file_tokens })),
                  agentStates: session.agentStates || {}, createdAt: session.createdAt,
                  archetypeId: session.archetypeId ?? null,
                  qualityScore: session.qualityScore ?? null,
                  pinned: !!session.pinned,
                  specialistAgents: session.specialistAgents || [],
                  totalTokens: _tokRow ? (_tokRow.total_tokens ?? null) : null,
                  tokenBreakdown: (function (j) { if (!j) return null; try { return JSON.parse(j); } catch { return null; } })(_tokRow && _tokRow.token_breakdown),
                  totalCostUsd: _tokRow ? (_tokRow.total_cost_usd ?? null) : null,
                  costBreakdown: (function (j) { if (!j) return null; try { return JSON.parse(j); } catch { return null; } })(_tokRow && _tokRow.cost_breakdown),
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
              pushSessionUpdate(session.id);
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
            // Skip over phases whose agents all already produced messages so
            // a resume lands on the first unfinished phase instead of redoing
            // divergence from scratch. PHASES.length means every phase ran —
            // there is nothing to resume.
            const resumePhase = computeResumePhase(resumeSession, PHASES);
            if (resumePhase >= PHASES.length) {
              ws.send(JSON.stringify({ type: 'error', message: 'Session already complete (all phases covered)', sessionId: msg.sessionId }));
              break;
            }
            resumeSession.phase = resumePhase;
            stmts.updateSessionPhase.run(resumePhase, Date.now(), resumeSession.id);
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
            pushSessionUpdate(resumeSession.id);
            withSession(resumeSession.id).info({ fromPhase: resumePhase }, 'resuming session');
            runDeliberation(resumeSession, resumePhase).catch(err => {
              withSession(resumeSession.id).error({ err: err.message }, 'resume deliberation error');
              broadcast(resumeSession.id, { type: 'error', message: err.message, sessionId: resumeSession.id });
            });
            break;
          }

          case 'delete-session': {
            // Stop a running deliberation before deleting so its next
            // insertMessage does not violate the foreign key against the
            // deleted row.
            const running = activeSessions.get(msg.sessionId);
            if (running) {
              running.active = false;
              abortSessionWaits(msg.sessionId, 'session deleted');
            }
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
