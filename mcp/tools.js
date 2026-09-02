const { z } = require('zod');
const { DEFAULT_LIMIT, MAX_LIMIT } = require('../lib/message-window');

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

  // Render a preflight report for a model client. The verdict comes first
  // because that is the only line a caller must act on; the per-phase detail
  // follows so a failure can be attributed without a second call.
  //
  // One dead provider fails every checkpoint with the same error, so failing
  // rows are grouped by (pair, error) and counted. A repeated wall of the same
  // 401 is not more information, it is the same information 31 times.
  const MAX_FAIL_LINES = 6;
  function formatPreflight(r) {
    if (!r) return '(no dry run was performed)';
    const lines = [];
    lines.push(r.ok
      ? `DRY RUN PASSED in ${r.durationMs}ms — ${r.checkpointCount} checkpoints across ${(r.phases || []).length} phases, ${r.probeCount} provider probe(s).`
      : `DRY RUN FAILED in ${r.durationMs}ms — ${r.failures.length} of ${r.checkpointCount} checkpoints could not run.`);

    if (r.ok) {
      lines.push('');
      for (const ph of r.phases || []) lines.push(`  [PASS] ${ph.name} (${(ph.agents || []).length} agents)`);
      for (const x of r.support || []) lines.push(`  [PASS] ${x.name} — ${x.model} via ${x.route}`);
      return lines.join('\n');
    }

    const rows = [];
    for (const ph of r.phases || []) for (const a of ph.agents || []) if (!a.ok) rows.push({ where: ph.name, ...a });
    for (const x of r.specialists || []) if (!x.ok) rows.push({ where: 'Specialists', ...x });
    for (const x of r.support || []) if (!x.ok) rows.push({ where: 'Support', ...x });

    const byCause = new Map();
    for (const row of rows) {
      const key = `${row.route}|${row.model}|${row.error}`;
      if (!byCause.has(key)) byCause.set(key, { route: row.route, model: row.model, error: row.error, who: [] });
      byCause.get(key).who.push(`${row.where}/${row.name}`);
    }

    lines.push('');
    lines.push('What failed:');
    const causes = [...byCause.values()];
    for (const c of causes.slice(0, MAX_FAIL_LINES)) {
      lines.push(`  ✗ ${c.model} via ${c.route || 'no route'} — ${c.who.length} checkpoint(s): ${c.error}`);
      lines.push(`      affects: ${c.who.slice(0, 4).join(', ')}${c.who.length > 4 ? `, +${c.who.length - 4} more` : ''}`);
    }
    if (causes.length > MAX_FAIL_LINES) lines.push(`  … and ${causes.length - MAX_FAIL_LINES} more distinct failure(s).`);

    const okPhases = (r.phases || []).filter(p => p.ok).map(p => p.name);
    if (okPhases.length) {
      lines.push('');
      lines.push(`Phases that would run: ${okPhases.join(', ')}.`);
    }
    return lines.join('\n');
  }

  // This line used to read `active ? 'Active' : 'Complete'`, so a run a
  // redeploy killed at Problem Framing was reported to the caller as Complete,
  // indistinguishable from one that reached Synthesis. Name the real terminal
  // state. A NULL outcome on an inactive row is a legacy session from before
  // the outcome column existed and is treated as complete.
  const TERMINAL_LABEL = {
    complete: 'Complete',
    stopped: 'Stopped before the last phase',
    failed: 'Failed (no verdict produced)',
    crashed: 'Crashed (server restarted mid-run)',
  };
  function sessionStatus(s) {
    if (s.active) return 'Running';
    return TERMINAL_LABEL[s.outcome] || 'Complete';
  }

  // How far the run got, so "stopped" carries a distance. `phase` is the
  // zero-based index of the phase the room was last IN, which is not the same
  // as the number it finished — the loop stamps it on entry — so this says
  // reached, not completed.
  function phaseProgress(s) {
    const total = s.totalPhases || 5;
    const reached = Math.min(total, (Number(s.phase) || 0) + 1);
    return `phase ${reached} of ${total} reached`;
  }

  // A poll should not carry text the caller already holds. Trim to a length
  // that still identifies the thing, and say how much was cut so nobody
  // mistakes a trimmed field for a short one.
  function trim(text, max) {
    const t = String(text ?? '');
    return t.length > max ? `${t.slice(0, max)}… (+${t.length - max} chars)` : t;
  }

  // How long ago the room last spoke. A poll asks "is this thing still moving"
  // and a bare timestamp makes the reader do the subtraction.
  // Finite is not the same as renderable: Date tops out at +/-8.64e15, so a
  // stamp written in microseconds or nanoseconds is a number JS accepts and
  // toISOString() then throws on. Null and '' coerce to 0, which would date the
  // room's last word to 1970 rather than admit the stamp is missing.
  function isoAt(ts) {
    if (ts === null || ts === undefined || ts === '') return null;
    const n = Number(ts);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  function ago(ts) {
    if (ts === null || ts === undefined || ts === '') return null;
    const ms = Date.now() - Number(ts);
    if (!Number.isFinite(ms) || ms < 0) return null;
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  // The transcript stand-in for a status poll: how much the room has said,
  // where, when it last spoke, and the cursor that reads the rest.
  function messageSummaryLines(sum) {
    const lines = [];
    if (!sum) return lines;
    lines.push(`Messages: ${sum.total} | Cursor: ${sum.cursor}`);
    if (sum.byPhase?.length) {
      lines.push(`  by phase: ${sum.byPhase.map(p => `${p.phase} ${p.count}`).join(', ')}`);
    }
    if (sum.latest) {
      // A malformed timestamp must cost the reader that one detail, not the
      // whole status line: `new Date(NaN).toISOString()` throws.
      const iso = isoAt(sum.latest.at);
      const when = iso ? ` — ${iso}` : '';
      const rel = iso ? ago(sum.latest.at) : null;
      const emoji = sum.latest.agentEmoji ? `${sum.latest.agentEmoji} ` : '';
      lines.push(`  latest: ${emoji}${sum.latest.agentName} [${sum.latest.phase}]${when}${rel ? ` (${rel})` : ''}`);
    }
    return lines;
  }

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
          // "Done" for every inactive row is the same lie the detail view told:
          // the list is where an empty run used to read as "Done | Synthesis".
          const status = s.active ? 'ACTIVE' : sessionStatus(s).toUpperCase();
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
    'Check one session: status, phase, cost, and every escalation, without the transcript. This is the poll — it stays the same small size while the deliberation grows, so call it every 1-2 min on a running room. Set includeMessages: true only when you actually want to read the deliberation. To follow a room as it talks, take the Cursor from this reply and pass it to warroom_get_messages as `since`, which returns only what the room said after that point.',
    {
      sessionId: z.string().describe('Session ID'),
      includeMessages: z.boolean().optional().describe('Include the full transcript and the human interjections. Default false: the reply is a status read plus a message summary and a cursor. Turn it on to read the deliberation, not to poll it.'),
    },
    async ({ sessionId, includeMessages = false }) => {
      try {
        const s = await ops.getSession(sessionId, { includeMessages });
        if (!s) return err(`Session ${sessionId} not found`);
        const lines = [
          `Session: ${s.id}`,
          // The problem statement runs to thousands of characters on a real
          // session. A poll needs enough of it to know which room this is.
          `Problem: ${includeMessages ? s.problem : trim(s.problem, 200)}`,
          `Status: ${sessionStatus(s)} | Phase: ${s.phaseName || s.phase} (${phaseProgress(s)})`,
          `Created: ${new Date(s.createdAt).toISOString()}`,
          `Tokens: ${s.totalTokens != null ? s.totalTokens.toLocaleString() : '—'}`,
          `Cost: ${fmtCost(s.totalCostUsd)}`,
          `Outcome: ${s.outcome || (s.active ? 'running' : 'complete')} | Quality: ${s.qualityScore != null ? s.qualityScore.toFixed(3) : '(none)'}`,
        ];
        if (s.failedTurns) {
          const last = s.lastError ? ` | Last error: ${String(s.lastError.error).slice(0, 240)}` : '';
          lines.push(`Failed turns: ${s.failedTurns}${last}`);
        }
        if (s.costBreakdown && typeof s.costBreakdown === 'object') {
          const parts = Object.entries(s.costBreakdown).map(([route, amt]) => `${route} ${fmtCost(amt)}`);
          if (parts.length) lines.push(`  by route: ${parts.join(', ')}`);
        }
        lines.push('');
        lines.push(...messageSummaryLines(s.messageSummary));
        if (s.humanMessageCount) lines.push(`Human interjections: ${s.humanMessageCount}`);
        if (!includeMessages) {
          const cursor = s.messageSummary?.cursor ?? 0;
          lines.push(`Transcript omitted. Set includeMessages: true to read it, or call warroom_get_messages with since: ${cursor} to read only what the room says next.`);
        }
        lines.push('');
        if (includeMessages && s.messages?.length) {
          lines.push(`--- Messages (${s.messages.length}) ---\n`);
          for (const m of s.messages) {
            lines.push(`${m.agentEmoji || ''} ${m.agentName || m.agent_name} [${m.phase}]:`);
            lines.push(m.content);
            lines.push('');
          }
        }
        if (s.escalations?.length) {
          const answered = s.escalations.filter(e => e.answered);
          const pending = s.escalations.filter(e => !e.answered);
          lines.push(`--- Escalations (${s.escalations.length} total, ${pending.length} pending) ---\n`);
          // A pending escalation is the reason to poll, so it always arrives
          // whole: the caller has to read the question to answer it. An
          // answered one is a question the caller already answered, and listing
          // every one of them would grow the poll with the room's own history,
          // so by default the header count carries them and nothing else does.
          for (const e of pending) {
            lines.push(`[${e.id}] ${e.agentName || e.agent_name}: "${e.question}" -> Pending`);
          }
          if (includeMessages) {
            for (const e of answered) {
              lines.push(`[${e.id}] ${e.agentName || e.agent_name}: "${e.question}" -> Answered: ${e.answer}`);
            }
          } else if (answered.length) {
            lines.push(`(${answered.length} answered escalation(s) omitted; set includeMessages: true to read them)`);
          }
          lines.push('');
        }
        if (includeMessages && s.humanMessages?.length) {
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
    'Start a new multi-agent deliberation. 8 agents work through 5 phases: Framing → Divergence → Convergence → Red Team → Synthesis. Runs async — poll warroom_get_session every 1-2 min (it returns status and escalations without the transcript) and answer pending escalations with warroom_answer_escalation while the room waits (an unanswered escalation resolves to the agent\'s stated default after 5 minutes, so a late answer costs quality, not the session). Read the Status line to know where a run ended: Running, Complete, Stopped, Failed, or Crashed, with the phases it got through. Only Complete means the room reached Synthesis. Use for decisions worth real deliberation: weeks-of-work commitments, post-failure adversarial reads, genuine 2-3 option uncertainty. NOT for routine questions answerable in a single response. Attach text context via `files` (inline name+content, uploaded to files-service) or `fileIds` (already in files-service).',
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
    'Answer a pending agent escalation. A blocking escalation wakes the room the moment you answer. Answering is worth doing, but it is not a deadline you can miss: an unanswered escalation resolves to the default the agent stated and the room carries on, so a late answer costs quality, never the session.',
    {
      escalationId: z.string().describe('Escalation ID'),
      answer: z.string().describe('Your answer'),
    },
    async ({ escalationId, answer }) => {
      try {
        const out = await ops.answerEscalation(escalationId, answer);
        const woke = out && out.resolved ? ' Deliberation resumed.' : '';
        return ok(`Escalation ${escalationId} answered.${woke}`);
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
    'Read a session\'s messages, in order, optionally filtered by agent or phase. Pass `since` with the Cursor from a previous reply to get only the messages added after it — that is how you follow a live room without re-reading what you already have. Every reply ends with the next Cursor, so a poll loop is: read, keep the Cursor, pass it back. `limit` pages a long log.',
    {
      sessionId: z.string().describe('Session ID'),
      agentId: z.string().optional().describe('Filter by agent ID'),
      phase: z.string().optional().describe('Filter by phase name'),
      since: z.number().int().optional().describe('Cursor from an earlier reply. Returns only messages after that point. It counts the session\'s whole log, so the same cursor means the same thing with or without a filter.'),
      limit: z.number().int().optional().describe(`Maximum messages in this page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). The reply says how many remain.`),
    },
    async ({ sessionId, agentId, phase, since, limit }) => {
      try {
        const page = await ops.getMessages(sessionId, { agentId, phase, since, limit });
        const { messages, total, nextCursor, truncated, remaining } = page;
        // Always hand back the cursor, including on an empty page: a poll that
        // finds nothing still has to advance, or it rescans the same tail
        // forever. `truncated` is what the limit cut; `remaining` is every
        // unread position, matching or not.
        const foot = [`Cursor: ${nextCursor} — pass since: ${nextCursor} to read only messages added after this page.`];
        if (remaining > 0) foot.push(`${remaining} more message(s) in the log after this page.${truncated ? ' Raise `limit` or poll again with the cursor.' : ''}`);

        if (!messages.length) {
          const why = total === 0 ? 'This session has no messages yet.'
            : page.since >= total ? `No new messages after cursor ${page.since} (the session has ${total}).`
            : 'No messages matching filters.';
          return ok(`${why}\n${foot.join(' ')}`);
        }

        const head = `Messages ${messages[0].seq}-${messages[messages.length - 1].seq} of ${total}:`;
        const lines = messages.map(m =>
          `#${m.seq} ${m.agent_emoji || m.agentEmoji || ''} ${m.agent_name || m.agentName} [${m.phase}]:\n${m.content}`
        );
        return ok(`${head}\n\n${lines.join('\n\n---\n\n')}\n\n${foot.join(' ')}`);
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
    'Set the model (and optionally the provider route) an agent uses. Pass agentId "all" to apply one pair to every agent. This is a SERVER-WIDE setting shared with the web UI and with any session already running — it is not scoped to your session or client.\n\nEVERY change is dry-run before it is stored. The call blocks for a few seconds while the server walks all five phases, the specialists and the support calls on the candidate configuration and fires one real minimal completion per distinct model. WAIT for the result and read it: if the dry run fails, NOTHING IS SAVED, the old configuration is still live, and the report names which phase and which agent could not run. Fix the model id or the route and call again — do not start a session on the assumption the change landed. Use force:true only to store a configuration you know fails right now (a provider that is down, being configured ahead of time). The default server model is claude-opus-5; clear:true drops an override back to it.',
    {
      agentId: z.string().describe('Agent id from warroom_list_agents (e.g. "red-teamer"), or "all" for every agent'),
      model: z.string().optional().describe('Model id as the provider expects it (e.g. "claude-opus-5", "x-ai/grok-2", "gpt-4o-mini"). Required unless clear:true.'),
      route: z.string().optional().describe('Provider route: anthropic-api, openai-api, openrouter, subscription, or ollama-local. Omit to keep the server default route. A non-default route REQUIRES an explicit model.'),
      clear: z.boolean().optional().describe('Remove this agent\'s override so it reverts to the server default model and route'),
      force: z.boolean().optional().describe('Store the configuration even though the dry run failed. Only for a provider you know is temporarily down. The next session will fail on every checkpoint the report listed.'),
    },
    async ({ agentId, model, route, clear, force }) => {
      try {
        if (!clear && !model && !route) return err('Provide a model (and optionally a route), or clear:true to reset this agent.');
        const result = await ops.setModel({ agentId, route, model, clear: !!clear, force: !!force });
        if (result.blocked) {
          return err(`NOT SAVED — the dry run failed, so the configuration was rejected and the previous one is still live.\n\n${formatPreflight(result.preflight)}\n\nFix the model id or route and call warroom_set_model again, or pass force:true to store it anyway.`);
        }
        const verdict = result.forced
          ? `\n\nSAVED WITH force:true DESPITE A FAILING DRY RUN.\n\n${formatPreflight(result.preflight)}`
          : `\n\n${formatPreflight(result.preflight)}`;
        if (clear) return ok(`Cleared model override for ${result.changed.join(', ')}. They now use the server default.${verdict}`);
        const entries = result.changed.map(id => {
          const e = result.routing[id] || {};
          return `  ${id}: ${e.model || '(default model)'}${e.route ? ` via ${e.route}` : ' via default route'}`;
        });
        return ok(`Model updated for ${result.changed.length} agent(s):\n${entries.join('\n')}\n\nApplies server-wide, effective immediately.${verdict}`);
      } catch (e) { return err(e.message); }
    }
  );

  // 15b. warroom_preflight
  server.tool(
    'warroom_preflight',
    'Dry-run the deliberation pipeline without starting a session and without changing anything. Walks all five phases, every specialist template and the five support calls that bracket the phases (fingerprint, memory, improver, adversarial twin, quality), resolves each one to its model and provider route, and fires one real minimal completion per distinct pair — including a tools-enabled probe, because every agent turn ships a tools array and a model that answers a plain prompt can still reject one. Takes a few seconds. Use it to check the live configuration before starting a session, or to test a candidate model without saving it: pass agentId + model to see what would happen if you set that pair. warroom_set_model runs this automatically, so this tool is for checking, not for saving.',
    {
      agentId: z.string().optional().describe('Check a candidate for this agent instead of the stored configuration. Use "all" for every agent. Requires model.'),
      model: z.string().optional().describe('Candidate model id to check with agentId. Nothing is persisted.'),
      route: z.string().optional().describe('Candidate provider route to check with agentId. A non-default route requires a model.'),
    },
    async ({ agentId, model, route }) => {
      try {
        let routing = null;
        if (agentId) {
          if (!model) return err('Checking a candidate needs a model id alongside agentId.');
          const cfg = await ops.getModelConfig();
          const known = new Set((cfg.agents || []).map(a => a.id));
          // sanitizeRouting drops an unknown id server-side without an error, so
          // a typo here would dry-run the live configuration and report a pass
          // for a candidate that was never tested.
          if (agentId !== 'all' && !known.has(agentId)) {
            return err(`unknown agent: ${agentId} (use warroom_list_agents for valid ids, or "all")`);
          }
          const ids = agentId === 'all' ? [...known] : [agentId];
          routing = { ...Object.fromEntries((cfg.agents || []).filter(a => a.configured).map(a => [a.id, a.configured])) };
          for (const id of ids) routing[id] = route ? { route, model } : { model };
        }
        const r = await ops.preflight({ routing });
        const scope = routing ? 'candidate configuration (not saved)' : 'live configuration';
        return ok(`Dry run of the ${scope}:\n\n${formatPreflight(r)}`);
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

  // 17. warroom_list_models
  server.tool(
    'warroom_list_models',
    'List the model ids a provider route actually serves, fetched live from the provider. Use it to pick a real id for warroom_set_model instead of guessing — includes every model behind the gateway (Claude, GPT, local Ollama, ...). Omit route to list the server default provider.',
    {
      route: z.string().optional().describe('Provider route to list: anthropic-api, openai-api, openrouter, subscription, or ollama-local. Omit for this deployment\'s default provider.'),
    },
    async ({ route }) => {
      try {
        const r = await ops.listModels({ route });
        if (!r.ok) return ok(`FAILED — ${r.route}: ${r.error}`);
        return ok(`${r.models.length} models via ${r.route}:\n\n${r.models.join('\n')}\n\nUse an id with warroom_set_model (verify first with warroom_test_model).`);
      } catch (e) { return err(e.message); }
    }
  );

  // ─── Session lifecycle, quality, recall ───────────────────────────────

  // 18. warroom_resume_session
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

  // 19. warroom_rate_session
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

  // 20. warroom_get_quality
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

  // 21. warroom_get_analytics
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

  // 22. warroom_semantic_search
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

  // 23. warroom_recall_similar
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

  // 24. warroom_improve_problem
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

  // 25. warroom_list_specialists
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

  // 26. warroom_get_session_agents
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

  // 27. warroom_get_phases
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

  // 28. warroom_get_status
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
