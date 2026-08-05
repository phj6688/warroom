const { z } = require('zod');

/**
 * Register all War Room MCP tools on a server instance.
 * `ops` is an adapter object providing data access methods.
 * Both HTTP (direct DB) and stdio (REST/WS) transports implement the same ops interface.
 */
function registerTools(server, rawOps) {

  // Both transports register the same tool list from one ops interface, so an
  // adapter that misses a method used to surface as "ops.X is not a function".
  // Answer with what actually happened instead, and keep the failure local to
  // the one tool rather than the whole transport.
  const ops = new Proxy(rawOps, {
    get(target, prop) {
      const value = target[prop];
      if (value === undefined && typeof prop === 'string') {
        return async () => { throw new Error(`${prop} is not supported by this War Room MCP transport`); };
      }
      return value;
    },
  });

  function ok(text) { return { content: [{ type: 'text', text }] }; }
  function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

  // One absent-cost token across list and detail. Sub-dollar costs keep 4
  // decimals so a fraction-of-a-cent session does not round to $0.00 (the live
  // panel shows the real value via the same precision rule).
  function fmtCost(n) {
    if (n == null) return '$—';
    const v = Number(n);
    // A malformed costBreakdown value (non-numeric, NaN, Infinity) must not
    // render as $NaN/$Infinity; fall back to the same absent-cost token.
    if (!Number.isFinite(v)) return '$—';
    return '$' + (v < 1 ? v.toFixed(4) : v.toFixed(2));
  }

  // 1. warroom_list_sessions
  server.tool(
    'warroom_list_sessions',
    'List all War Room research sessions with summary info',
    {},
    async () => {
      try {
        const sessions = await ops.listSessions();
        if (!sessions.length) return ok('No sessions yet. Use warroom_create_session to start one.');
        const rows = sessions.map(s => {
          const date = new Date(s.createdAt).toISOString().slice(0, 16);
          const status = s.active ? 'ACTIVE' : 'Done';
          const tok = s.totalTokens != null ? `${s.totalTokens.toLocaleString()} tok` : '— tok';
          const cost = fmtCost(s.totalCostUsd);
          return `[${s.id}] ${status} | Phase: ${s.phaseName || s.phase} | ${s.messageCount || 0} msgs | ${s.pendingCount || 0} pending | ${tok} | ${cost} | ${date}\n  ${s.problem.slice(0, 120)}`;
        });
        return ok(`Sessions (${sessions.length}):\n\n${rows.join('\n\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 2. warroom_get_session
  server.tool(
    'warroom_get_session',
    'Get full session detail: messages, escalations, human interjections',
    { sessionId: z.string().describe('Session ID') },
    async ({ sessionId }) => {
      try {
        const s = await ops.getSession(sessionId);
        if (!s) return err(`Session ${sessionId} not found`);
        const lines = [
          `Session: ${s.id}`,
          `Problem: ${s.problem}`,
          `Status: ${s.active ? 'Active' : 'Complete'} | Phase: ${s.phaseName || s.phase}`,
          `Created: ${new Date(s.createdAt).toISOString()}`,
          `Tokens: ${s.totalTokens != null ? s.totalTokens.toLocaleString() : '—'}`,
          `Cost: ${fmtCost(s.totalCostUsd)}`,
          `Outcome: ${s.outcome || (s.active ? 'running' : 'complete')} | Quality: ${s.qualityScore != null ? s.qualityScore.toFixed(3) : '(none)'}`,
        ];
        if (s.costBreakdown && typeof s.costBreakdown === 'object') {
          const parts = Object.entries(s.costBreakdown).map(([route, amt]) => `${route} ${fmtCost(amt)}`);
          if (parts.length) lines.push(`  by route: ${parts.join(', ')}`);
        }
        lines.push('');
        if (s.messages?.length) {
          lines.push(`--- Messages (${s.messages.length}) ---\n`);
          for (const m of s.messages) {
            lines.push(`${m.agentEmoji || ''} ${m.agentName || m.agent_name} [${m.phase}]:`);
            lines.push(m.content);
            lines.push('');
          }
        }
        if (s.escalations?.length) {
          lines.push(`--- Escalations (${s.escalations.length}) ---\n`);
          for (const e of s.escalations) {
            const st = e.answered ? `Answered: ${e.answer}` : 'Pending';
            lines.push(`[${e.id}] ${e.agentName || e.agent_name}: "${e.question}" -> ${st}`);
          }
          lines.push('');
        }
        if (s.humanMessages?.length) {
          lines.push(`--- Human Interjections (${s.humanMessages.length}) ---\n`);
          for (const h of s.humanMessages) lines.push(`- ${h.content}`);
        }
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    }
  );

  // warroom_get_decision_record
  server.tool(
    'warroom_get_decision_record',
    'Get the verbatim Decision Record (the Synthesis-phase verdict) for a session as JSON, without the full transcript and with no extra LLM call. Returns available:false for a failed or synthesis-less session.',
    { sessionId: z.string().describe('Session ID') },
    async ({ sessionId }) => {
      try {
        const rec = await ops.getDecisionRecord(sessionId);
        if (!rec) return err(`Session ${sessionId} not found`);
        return ok(JSON.stringify(rec, null, 2));
      } catch (e) { return err(e.message); }
    }
  );

  // 3. warroom_create_session
  server.tool(
    'warroom_create_session',
    'Start a new multi-agent deliberation. 8 agents work through 5 phases: Framing → Divergence → Convergence → Red Team → Synthesis. Runs async — poll warroom_get_session every 1-2 min and answer pending escalations with warroom_answer_escalation promptly (unanswered escalations block progress). Use for decisions worth real deliberation: weeks-of-work commitments, post-failure adversarial reads, genuine 2-3 option uncertainty. NOT for routine questions answerable in a single response. Attach text context via `files` (inline name+content, uploaded to files-service) or `fileIds` (already in files-service).',
    {
      problem: z.string().describe('Problem statement. Agents see this verbatim every turn — it is the largest single quality lever. Strong statements include: (1) context, (2) the core question or decision, (3) hard constraints, (4) success criteria for a good answer, (5) explicit intent — comparison, recommendation, design, analysis, or decision. Name the tradeoffs and stakeholder perspectives that matter. Keep short problems short; add structure only when it aids clarity. Do not invent requirements that were not stated.'),
      files: z.array(z.object({
        name: z.string().describe('File name with extension (e.g. "audit.md"); used to infer mime'),
        content: z.string().describe('UTF-8 text content'),
      })).optional().describe('Inline text files; uploaded to files-service automatically. Inline budget ~150k tokens total — larger files are RAG-routed and only retrieved when a query is provided.'),
      fileIds: z.array(z.string()).optional().describe('Existing files-service file IDs to attach'),
      presetId: z.string().optional().describe('Role preset seeding domain specialists and the synthesis header set. Use warroom_list_presets for ids ("engineer", "scientist"). Omit for the generalist default.'),
      continuesFromSessionId: z.string().optional().describe('Seed this deliberation from a prior session\'s verdict, so a follow-up decision starts where the last one landed instead of from scratch.'),
    },
    async ({ problem, files, fileIds, presetId, continuesFromSessionId }) => {
      try {
        const result = await ops.createSession(problem, files || [], fileIds || [], presetId || null, continuesFromSessionId || null);
        const fileLine = result.fileIds?.length ? `\nFiles: ${result.fileIds.length} attached (${result.fileIds.join(', ')})` : '';
        const presetLine = result.presetId ? `\nPreset: ${result.presetId}` : '';
        const contLine = result.continuesFromSessionId ? `\nContinues from: ${result.continuesFromSessionId}` : '';
        return ok(`Session created: ${result.id}\nProblem: ${result.problem}${presetLine}${contLine}${fileLine}\n\nDeliberation running. Use warroom_get_session to check progress.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 3c. warroom_list_presets
  server.tool(
    'warroom_list_presets',
    'List the role presets accepted by warroom_create_session. A preset seeds which domain specialists join the room and which headers the synthesis is written under. No preset (the default) is the generalist room.',
    {},
    async () => {
      try {
        const presets = await ops.listPresets();
        if (!presets.length) return ok('No presets configured; sessions run the generalist room.');
        const lines = presets.map(p => `[${p.id}] ${p.label} — ${p.tagline}\n  specialists: ${(p.specialists || []).join(', ')}`);
        return ok(`Presets (${presets.length}):\n\n${lines.join('\n\n')}\n\nOmit presetId for the generalist room.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 3b. warroom_attach_files
  server.tool(
    'warroom_attach_files',
    'Attach additional text files to an existing session. Uploads inline content to files-service and registers them on the session.',
    {
      sessionId: z.string().describe('Session ID to attach files to'),
      files: z.array(z.object({
        name: z.string().describe('File name with extension'),
        content: z.string().describe('UTF-8 text content'),
      })).optional().describe('Inline text files'),
      fileIds: z.array(z.string()).optional().describe('Existing files-service file IDs'),
    },
    async ({ sessionId, files, fileIds }) => {
      try {
        const result = await ops.attachFiles(sessionId, files || [], fileIds || []);
        return ok(`Attached ${result.fileIds.length} file(s) to session ${result.sessionId}: ${result.fileIds.join(', ')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 4. warroom_delete_session
  server.tool(
    'warroom_delete_session',
    'Permanently delete a session and all its data',
    { sessionId: z.string().describe('Session ID to delete') },
    async ({ sessionId }) => {
      try {
        await ops.deleteSession(sessionId);
        return ok(`Session ${sessionId} deleted.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 5. warroom_stop_session
  server.tool(
    'warroom_stop_session',
    'Stop an active deliberation immediately',
    { sessionId: z.string().describe('Session ID to stop') },
    async ({ sessionId }) => {
      try {
        await ops.stopSession(sessionId);
        return ok(`Session ${sessionId} stopped.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 6. warroom_send_message
  server.tool(
    'warroom_send_message',
    'Inject a human message into an active session. Agents in subsequent turns see it as context.',
    {
      sessionId: z.string().describe('Active session ID'),
      message: z.string().describe('Your message to the agents'),
    },
    async ({ sessionId, message }) => {
      try {
        await ops.sendMessage(sessionId, message);
        return ok(`Message delivered to session ${sessionId}.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 7. warroom_answer_escalation
  server.tool(
    'warroom_answer_escalation',
    'Answer a pending agent escalation to unblock deliberation',
    {
      escalationId: z.string().describe('Escalation ID'),
      answer: z.string().describe('Your answer'),
    },
    async ({ escalationId, answer }) => {
      try {
        await ops.answerEscalation(escalationId, answer);
        return ok(`Escalation ${escalationId} answered.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 8. warroom_get_escalations
  server.tool(
    'warroom_get_escalations',
    'List pending escalations across all sessions or for a specific session',
    {
      sessionId: z.string().optional().describe('Filter by session ID (optional)'),
    },
    async ({ sessionId }) => {
      try {
        const escalations = await ops.getEscalations(sessionId);
        if (!escalations.length) return ok('No pending escalations.');
        const lines = escalations.map(e =>
          `[${e.id}] Session: ${e.session_id || e.sessionId} | ${e.agent_emoji || ''} ${e.agent_name || e.agentName}: "${e.question}"`
        );
        return ok(`Pending Escalations (${escalations.length}):\n\n${lines.join('\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 9. warroom_get_messages
  server.tool(
    'warroom_get_messages',
    'Get messages from a session, optionally filtered by agent or phase',
    {
      sessionId: z.string().describe('Session ID'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      phase: z.string().optional().describe('Filter by phase name'),
    },
    async ({ sessionId, agentId, phase }) => {
      try {
        const messages = await ops.getMessages(sessionId, agentId, phase);
        if (!messages.length) return ok('No messages matching filters.');
        const lines = messages.map(m =>
          `${m.agent_emoji || m.agentEmoji || ''} ${m.agent_name || m.agentName} [${m.phase}]:\n${m.content}`
        );
        return ok(lines.join('\n\n---\n\n'));
      } catch (e) { return err(e.message); }
    }
  );

  // 10. warroom_ask_question
  server.tool(
    'warroom_ask_question',
    'Ask a follow-up question to an active or completed session. Process Architect answers based on full deliberation context.',
    {
      sessionId: z.string().describe('Session ID'),
      question: z.string().describe('Follow-up question for the agents'),
    },
    async ({ sessionId, question }) => {
      try {
        const response = await ops.askQuestion(sessionId, question);
        return ok(`[Process Architect]\n\n${response}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 11. warroom_export_session
  server.tool(
    'warroom_export_session',
    'Export a session. mode: full_transcript (default), end_result (final synthesis only), or end_result_with_qa (synthesis plus escalation Q&A). format: md (default, human-readable) or json (structured, for programmatic use).',
    {
      sessionId: z.string().describe('Session ID'),
      mode: z.enum(['full_transcript', 'end_result', 'end_result_with_qa']).optional().describe('Export scope; default full_transcript'),
      format: z.enum(['md', 'json']).optional().describe('Output format; default md'),
    },
    async ({ sessionId, mode, format }) => {
      try {
        const out = await ops.exportSession(sessionId, mode, format);
        return ok(out);
      } catch (e) { return err(e.message); }
    }
  );

  // 12. warroom_search_sessions
  server.tool(
    'warroom_search_sessions',
    'Search sessions by keyword in problem statement or messages',
    { query: z.string().describe('Search keyword') },
    async ({ query }) => {
      try {
        const sessions = await ops.searchSessions(query);
        if (!sessions.length) return ok(`No sessions matching "${query}".`);
        const lines = sessions.map(s => {
          const date = new Date(s.createdAt || s.created_at).toISOString().slice(0, 16);
          return `[${s.id}] ${s.active ? 'Active' : 'Done'} | ${date}\n  ${s.problem.slice(0, 120)}`;
        });
        return ok(`Search "${query}" — ${sessions.length} results:\n\n${lines.join('\n\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 13. warroom_list_agents
  server.tool(
    'warroom_list_agents',
    'List all 8 cognitive agents with their roles and thinking hats',
    {},
    async () => {
      try {
        const agents = await ops.listAgents();
        const text = agents.map(a => `${a.emoji} ${a.name} — ${a.role} (${a.hat})`).join('\n');
        return ok(`War Room Agents:\n\n${text}`);
      } catch (e) { return err(e.message); }
    }
  );

  // ─── Model / provider routing ─────────────────────────────────────────
  // These write the same server-wide store the Settings panel writes. There is
  // no per-session model override, so a change here applies to every session on
  // this server, including ones already running. Say so in the descriptions
  // rather than letting a caller discover it by surprising a concurrent run.

  // 14. warroom_get_model_config
  server.tool(
    'warroom_get_model_config',
    'Show which model and provider route each agent resolves to right now, which routes have credentials on this server, and which agents carry an explicit override. Call this before warroom_set_model so you change from a known state.',
    {},
    async () => {
      try {
        const cfg = await ops.getModelConfig();
        const avail = Object.entries(cfg.available).map(([r, on]) => `${r}${on ? '' : ' (no credentials)'}`).join(', ');
        const rows = cfg.agents.map(a => {
          const src = a.configured ? 'override' : 'default';
          const route = a.effective.route || '(none configured)';
          return `${a.emoji || ''} ${a.name} [${a.id}]\n  ${a.effective.model} via ${route} (${src})`;
        });
        return ok(`Routes: ${avail}\n\nAgents (${cfg.agents.length}):\n\n${rows.join('\n')}\n\nChange with warroom_set_model. Settings are server-wide, not per session.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 15. warroom_set_model
  server.tool(
    'warroom_set_model',
    'Set the model (and optionally the provider route) an agent uses. Pass agentId "all" to apply one pair to every agent. This is a SERVER-WIDE setting shared with the web UI and with any session already running — it is not scoped to your session or client. Applies immediately, no restart. Use clear:true to drop an override and fall back to the server default. Verify a pair first with warroom_test_model: an unreachable model id fails every agent turn.',
    {
      agentId: z.string().describe('Agent id from warroom_list_agents (e.g. "red-teamer"), or "all" for every agent'),
      model: z.string().optional().describe('Model id as the provider expects it (e.g. "claude-opus-5", "x-ai/grok-2", "gpt-4o-mini"). Required unless clear:true.'),
      route: z.string().optional().describe('Provider route: anthropic-api, openai-api, openrouter, subscription, or ollama-local. Omit to keep the server default route. A non-default route REQUIRES an explicit model.'),
      clear: z.boolean().optional().describe('Remove this agent\'s override so it reverts to the server default model and route'),
    },
    async ({ agentId, model, route, clear }) => {
      try {
        if (!clear && !model && !route) return err('Provide a model (and optionally a route), or clear:true to reset this agent.');
        const result = await ops.setModel({ agentId, route, model, clear: !!clear });
        if (clear) return ok(`Cleared model override for ${result.changed.join(', ')}. They now use the server default.`);
        const entries = result.changed.map(id => {
          const e = result.routing[id] || {};
          return `  ${id}: ${e.model || '(default model)'}${e.route ? ` via ${e.route}` : ' via default route'}`;
        });
        return ok(`Model updated for ${result.changed.length} agent(s):\n${entries.join('\n')}\n\nApplies server-wide, effective immediately.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 16. warroom_test_model
  server.tool(
    'warroom_test_model',
    'Fire a 1-token completion at a route + model pair and report whether the provider answers, plus latency. Use it to prove a model id before warroom_set_model — a typo only shows up as failing agent turns otherwise. Nothing is persisted.',
    {
      model: z.string().optional().describe('Model id to probe. Omit with route omitted to probe the server default.'),
      route: z.string().optional().describe('Provider route to probe: anthropic-api, openai-api, openrouter, subscription, ollama-local. Omit for this deployment\'s default provider. A non-default route requires a model.'),
    },
    async ({ model, route }) => {
      try {
        const r = await ops.testModel({ route, model });
        if (r.ok) return ok(`OK — ${r.model} via ${r.route} answered in ${r.latencyMs}ms.`);
        return ok(`FAILED — ${r.model || '(no model)'} via ${r.route}: ${r.error}`);
      } catch (e) { return err(e.message); }
    }
  );

  // ─── Session lifecycle, quality, recall ───────────────────────────────

  // 17. warroom_resume_session
  server.tool(
    'warroom_resume_session',
    'Restart a stopped or interrupted session at its first unfinished phase. Phases whose agents already spoke are skipped, so this continues rather than re-running the deliberation. Errors if the session is already running or every phase is covered.',
    { sessionId: z.string().describe('Session ID to resume') },
    async ({ sessionId }) => {
      try {
        const r = await ops.resumeSession(sessionId);
        return ok(`Session ${r.sessionId} resumed from phase ${r.resumedFromPhase}. Poll warroom_get_session for progress.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 18. warroom_rate_session
  server.tool(
    'warroom_rate_session',
    'Record whether a finished deliberation was actually useful. This is the only human signal on deliberation quality — rate a session once you have acted on its verdict so regressions stay visible.',
    {
      sessionId: z.string().describe('Session ID'),
      rating: z.enum(['USEFUL', 'PARTIAL', 'MISLEADING']).describe('USEFUL: the verdict was actionable. PARTIAL: some value, needed rework. MISLEADING: the verdict pointed the wrong way.'),
    },
    async ({ sessionId, rating }) => {
      try {
        const r = await ops.rateSession(sessionId, rating);
        return ok(`Session ${r.sessionId} rated ${r.rating}.`);
      } catch (e) { return err(e.message); }
    }
  );

  // 19. warroom_get_quality
  server.tool(
    'warroom_get_quality',
    'Quality scoring for one session: composite score, its breakdown, the human rating if one was recorded, and the shadow answer (what a single naive model said about the same problem). shadow_delta is the honest read on whether the deliberation beat that baseline.',
    { sessionId: z.string().describe('Session ID') },
    async ({ sessionId }) => {
      try {
        const q = await ops.getQuality(sessionId);
        const lines = [`Session: ${q.sessionId}`];
        lines.push(`Composite score: ${q.score != null ? q.score.toFixed(3) : '(not scored yet)'}`);
        if (q.breakdown) {
          for (const [k, v] of Object.entries(q.breakdown)) {
            lines.push(`  ${k}: ${typeof v === 'number' ? v.toFixed(3) : v}`);
          }
        }
        lines.push(`Human rating: ${q.humanRating || '(none — use warroom_rate_session)'}`);
        if (q.evaluatorModel) lines.push(`Evaluator: ${q.evaluatorModel}`);
        if (q.shadowAnswer) lines.push(`\n--- Shadow answer (single-model baseline) ---\n${q.shadowAnswer}`);
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    }
  );

  // 20. warroom_get_analytics
  server.tool(
    'warroom_get_analytics',
    'Quality analytics across all scored sessions: average composite score, rolling trend, per-dimension averages, and the best and worst sessions. Failed runs are excluded.',
    {},
    async () => {
      try {
        const a = await ops.getAnalytics();
        if (!a.count) return ok('No scored sessions yet.');
        const lines = [`Scored sessions: ${a.count}`, `Average composite: ${a.avg.toFixed(3)}`];
        if (a.breakdown_avg) {
          lines.push('\nPer-dimension averages:');
          for (const [k, v] of Object.entries(a.breakdown_avg)) lines.push(`  ${k}: ${typeof v === 'number' ? v.toFixed(3) : v}`);
        }
        if (a.topSessions?.length) {
          lines.push('\nBest:');
          for (const s of a.topSessions) lines.push(`  [${s.session_id}] ${s.score.toFixed(3)} — ${String(s.problem).slice(0, 80)}`);
        }
        if (a.bottomSessions?.length) {
          lines.push('\nWorst:');
          for (const s of a.bottomSessions) lines.push(`  [${s.session_id}] ${s.score.toFixed(3)} — ${String(s.problem).slice(0, 80)}`);
        }
        return ok(lines.join('\n'));
      } catch (e) { return err(e.message); }
    }
  );

  // 21. warroom_semantic_search
  server.tool(
    'warroom_semantic_search',
    'Find past sessions by meaning rather than keyword, ranked by similarity. Use it before opening a new deliberation to check whether this decision was already argued. Requires the embedding backend; falls back with an error if it is down (use warroom_search_sessions then).',
    {
      query: z.string().describe('Natural-language description of the decision or topic'),
      limit: z.number().optional().describe('Max results, 1-20 (default 10)'),
    },
    async ({ query, limit }) => {
      try {
        const results = await ops.semanticSearch(query, limit);
        if (!results.length) return ok(`No semantically similar sessions for "${query}".`);
        const lines = results.map(s => {
          const date = new Date(s.createdAt).toISOString().slice(0, 16);
          return `[${s.id}] similarity ${s.similarity.toFixed(3)} | ${s.active ? 'Active' : 'Done'} | ${date}\n  ${s.problem.slice(0, 120)}`;
        });
        return ok(`Semantic search "${query}" — ${results.length} results:\n\n${lines.join('\n\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 22. warroom_recall_similar
  server.tool(
    'warroom_recall_similar',
    'Retrieve distilled lessons from past deliberations relevant to a problem. This is the memory layer the agents themselves draw on — reading it first tells you what the room already concluded about this class of problem.',
    {
      query: z.string().describe('Problem or topic to recall lessons for'),
      limit: z.number().optional().describe('Max memories, 1-10 (default 3)'),
    },
    async ({ query, limit }) => {
      try {
        const results = await ops.recallSimilar(query, limit);
        if (!results || !results.length) return ok(`No stored lessons matching "${query}".`);
        return ok(`Recalled ${results.length} memory item(s):\n\n${JSON.stringify(results, null, 2)}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 23. warroom_improve_problem
  server.tool(
    'warroom_improve_problem',
    'Rewrite a rough problem statement into the structured form the agents deliberate best on. The problem statement is the largest single quality lever on a session, so run a thin or rushed one through this before warroom_create_session. Returns the rewrite only — nothing is created.',
    { problem: z.string().describe('Draft problem statement to rewrite') },
    async ({ problem }) => {
      try {
        const improved = await ops.improveProblem(problem);
        return ok(improved);
      } catch (e) { return err(e.message); }
    }
  );

  // 24. warroom_list_specialists
  server.tool(
    'warroom_list_specialists',
    'List the domain specialist templates that can join a room on top of the 8 core agents. Presets seed these automatically; use warroom_get_session_agents to see who actually joined a given session.',
    {},
    async () => {
      try {
        const templates = await ops.listSpecialists();
        if (!templates.length) return ok('No specialist templates registered.');
        const lines = templates.map(t => `${t.emoji || ''} ${t.name} [${t.id}] — ${t.role} (domain: ${t.domain})`);
        return ok(`Specialist templates (${templates.length}):\n\n${lines.join('\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 25. warroom_get_session_agents
  server.tool(
    'warroom_get_session_agents',
    'The exact roster for one session: the 8 core agents plus whichever domain specialists were spawned for it.',
    { sessionId: z.string().describe('Session ID') },
    async ({ sessionId }) => {
      try {
        const agents = await ops.getSessionAgents(sessionId);
        const core = agents.filter(a => !a.isSpecialist).map(a => `${a.emoji || ''} ${a.name} [${a.id}] — ${a.role}`);
        const spec = agents.filter(a => a.isSpecialist).map(a => `${a.emoji || ''} ${a.name} [${a.id}] — ${a.role} (${a.domain})`);
        let out = `Core agents (${core.length}):\n${core.join('\n')}`;
        out += spec.length ? `\n\nSpecialists (${spec.length}):\n${spec.join('\n')}` : '\n\nSpecialists: none';
        return ok(out);
      } catch (e) { return err(e.message); }
    }
  );

  // 26. warroom_get_phases
  server.tool(
    'warroom_get_phases',
    'The deliberation phase sequence and which agents speak in each. Use it to read a session\'s phase number against what is actually happening.',
    {},
    async () => {
      try {
        const phases = await ops.getPhases();
        const lines = phases.map(p => `${p.index}. ${p.name} — ${(p.agents || []).join(', ')}`);
        return ok(`Phases (${phases.length}):\n\n${lines.join('\n')}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 27. warroom_get_status
  server.tool(
    'warroom_get_status',
    'Server health, session counts, and agent roster',
    {},
    async () => {
      try {
        const status = await ops.getStatus();
        return ok(status);
      } catch (e) { return err(e.message); }
    }
  );
}

module.exports = { registerTools };
