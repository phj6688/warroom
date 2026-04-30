const { z } = require('zod');

/**
 * Register all War Room MCP tools on a server instance.
 * `ops` is an adapter object providing data access methods.
 * Both HTTP (direct DB) and stdio (REST/WS) transports implement the same ops interface.
 */
function registerTools(server, ops) {

  function ok(text) { return { content: [{ type: 'text', text }] }; }
  function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

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
          return `[${s.id}] ${status} | Phase: ${s.phaseName || s.phase} | ${s.messageCount || 0} msgs | ${s.pendingCount || 0} pending | ${date}\n  ${s.problem.slice(0, 120)}`;
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
          '',
        ];
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
    },
    async ({ problem, files, fileIds }) => {
      try {
        const result = await ops.createSession(problem, files || [], fileIds || []);
        const fileLine = result.fileIds?.length ? `\nFiles: ${result.fileIds.length} attached (${result.fileIds.join(', ')})` : '';
        return ok(`Session created: ${result.id}\nProblem: ${result.problem}${fileLine}\n\nDeliberation running. Use warroom_get_session to check progress.`);
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
    'Export a session as formatted Markdown',
    { sessionId: z.string().describe('Session ID') },
    async ({ sessionId }) => {
      try {
        const md = await ops.exportSession(sessionId);
        return ok(md);
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

  // 14. warroom_get_status
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
