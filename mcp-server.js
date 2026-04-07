const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const crypto = require('crypto');

/**
 * War Room MCP Server — Streamable HTTP, session-based
 * Mounted on the Express app at /mcp
 *
 * Each MCP client gets its own session (transport + server instance).
 * Sessions are tracked by Mcp-Session-Id header.
 */

const MCP_API_KEY = process.env.MCP_API_KEY || crypto.randomBytes(32).toString('hex');
process.env.MCP_API_KEY = MCP_API_KEY;

function setupMCPServer(app, deps) {
  const { db, callLLM, createSession, runDeliberation, activeSessions, AGENTS, PHASES } = deps;

  // Active MCP sessions: sessionId -> { transport, server, lastActivityAt }
  const mcpSessions = new Map();

  // Session TTL: clean up sessions inactive for this long (default 30 min)
  const SESSION_TTL = parseInt(process.env.MCP_SESSION_TTL || '1800000');
  const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, session] of mcpSessions) {
      if (now - session.lastActivityAt > SESSION_TTL) {
        mcpSessions.delete(sid);
        try { session.transport.close?.(); } catch (_) {}
        console.log(`MCP session expired (TTL): ${sid}`);
      }
    }
  }, SESSION_CLEANUP_INTERVAL);
  cleanupTimer.unref();

  function registerTools(server) {
    server.tool(
      'warroom_list_sessions',
      'List all War Room research sessions with summary info',
      {},
      async () => {
        try {
          const sessions = db.getSessions.all();
          if (!sessions.length) return ok('No sessions yet.');

          const rows = sessions.map(s => {
            const msgs = db.getSessionMessages.all(s.id);
            const pending = db.getPendingEscalations.all(s.id);
            const date = new Date(s.created_at).toISOString().slice(0, 16);
            const status = s.active ? 'ACTIVE' : 'Done';
            return `[${s.id}] ${status} | Phase: ${PHASES[s.phase]?.name || s.phase} | ${msgs.length} msgs | ${pending.length} pending | ${date}\n  ${s.problem.slice(0, 120)}`;
          });
          return ok(`Sessions (${sessions.length}):\n\n${rows.join('\n\n')}`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_get_session',
      'Get full session detail: messages, escalations, human interjections',
      { sessionId: z.string().describe('Session ID') },
      async ({ sessionId }) => {
        try {
          const s = db.getSession.get(sessionId);
          if (!s) return err(`Session ${sessionId} not found`);

          const messages = db.getSessionMessages.all(sessionId);
          const escalations = db.getSessionEscalations.all(sessionId);
          const humanMsgs = db.getSessionHumanMessages.all(sessionId);

          const lines = [
            `Session: ${s.id}`,
            `Problem: ${s.problem}`,
            `Status: ${s.active ? 'Active' : 'Complete'} | Phase: ${PHASES[s.phase]?.name || s.phase}`,
            `Created: ${new Date(s.created_at).toISOString()}`,
            '',
          ];

          if (messages.length) {
            lines.push(`--- Messages (${messages.length}) ---\n`);
            for (const m of messages) {
              lines.push(`${m.agent_emoji} ${m.agent_name} [${m.phase}]:`);
              lines.push(m.content);
              lines.push('');
            }
          }

          if (escalations.length) {
            lines.push(`--- Escalations (${escalations.length}) ---\n`);
            for (const e of escalations) {
              const st = e.status === 'answered' ? `Answered: ${e.answer}` : 'Pending';
              lines.push(`[${e.id}] ${e.agent_name}: "${e.question}" -> ${st}`);
            }
            lines.push('');
          }

          if (humanMsgs.length) {
            lines.push(`--- Human Interjections (${humanMsgs.length}) ---\n`);
            for (const h of humanMsgs) lines.push(`- ${h.content}`);
          }

          return ok(lines.join('\n'));
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_create_session',
      'Start a new multi-agent research deliberation. 8 agents analyze through 5 phases: Framing -> Divergence -> Convergence -> Red Team -> Synthesis. Runs async — poll with warroom_get_session.',
      {
        problem: z.string().describe('Problem, question, or research challenge'),
        files: z.array(z.object({
          name: z.string().describe('File name (e.g. "audit.md")'),
          content: z.string().describe('File text content'),
        })).optional().describe('Optional context files to attach to the session'),
      },
      async ({ problem, files }) => {
        try {
          const fileObjs = (files || []).map((f, i) => ({
            id: `file-${Date.now()}-${i}`,
            name: f.name,
            size: f.content.length,
            type: 'text/plain',
            content: f.content,
          }));
          const session = createSession(problem, fileObjs);
          runDeliberation(session).catch(e => console.error('MCP deliberation error:', e.message));
          return ok(`Session created: ${session.id}\nProblem: ${session.problem}\n\nDeliberation running. Use warroom_get_session to check progress.`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_delete_session',
      'Permanently delete a session and all its data',
      { sessionId: z.string().describe('Session ID to delete') },
      async ({ sessionId }) => {
        try {
          const s = db.getSession.get(sessionId);
          if (!s) return err(`Session ${sessionId} not found`);
          db.deleteSession.run(sessionId);
          activeSessions.delete(sessionId);
          return ok(`Session ${sessionId} deleted.`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_ask_question',
      'Ask a follow-up question to an active or completed session. Process Architect answers based on full deliberation context.',
      {
        sessionId: z.string().describe('Session ID'),
        question: z.string().describe('Follow-up question for the agents'),
      },
      async ({ sessionId, question }) => {
        try {
          const s = db.getSession.get(sessionId);
          if (!s) return err(`Session ${sessionId} not found`);

          const messages = db.getSessionMessages.all(sessionId);
          let files = [];
          try { files = db.getSessionFiles.all(sessionId); } catch (_) {}

          const architect = AGENTS.find(a => a.id === 'process-architect');
          const context = messages.map(m => `[${m.agent_name}]: ${m.content}`).join('\n\n');

          const systemPrompt = architect.systemPrompt + '\n\nYou are in Q&A mode. Answer the human\'s follow-up question based on the full deliberation context.';

          let userContent = `ORIGINAL PROBLEM:\n${s.problem}\n\n`;
          if (files.length) {
            userContent += files.map(f => `FILE: ${f.name}\n${f.content || '[binary]'}`).join('\n\n') + '\n\n';
          }
          userContent += `FULL DELIBERATION:\n${context}\n\nHUMAN QUESTION:\n${question}\n\nProvide a comprehensive answer.`;

          const response = await callLLM(systemPrompt, [{ role: 'user', content: userContent }], 'process-architect');

          return ok(`[Process Architect]\n\n${response}`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_answer_escalation',
      'Answer a pending agent escalation to unblock deliberation',
      {
        escalationId: z.string().describe('Escalation ID'),
        answer: z.string().describe('Your answer'),
      },
      async ({ escalationId, answer }) => {
        try {
          db.answerEscalation.run(answer, Date.now(), escalationId);
          // Update in-memory state so the deliberation loop unblocks
          for (const [, session] of activeSessions) {
            const esc = session.escalations?.find(e => e.id === escalationId);
            if (esc) {
              esc.answered = true;
              esc.answer = answer;
              break;
            }
          }
          return ok(`Escalation ${escalationId} answered.`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_get_escalations',
      'List pending escalations across all sessions or for a specific session',
      {
        sessionId: z.string().optional().describe('Filter by session ID (optional)'),
      },
      async ({ sessionId }) => {
        try {
          let escalations;
          if (sessionId) {
            escalations = db.getPendingEscalations.all(sessionId);
          } else {
            escalations = db.getAllPendingEscalations.all();
          }
          if (!escalations.length) return ok('No pending escalations.');

          const lines = escalations.map(e =>
            `[${e.id}] Session: ${e.session_id} | ${e.agent_emoji} ${e.agent_name}: "${e.question}"`
          );
          return ok(`Pending Escalations (${escalations.length}):\n\n${lines.join('\n')}`);
        } catch (e) { return err(e.message); }
      }
    );

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
          let messages = db.getSessionMessages.all(sessionId);
          if (agentId) messages = messages.filter(m => m.agent_id === agentId);
          if (phase) messages = messages.filter(m => m.phase === phase);

          if (!messages.length) return ok('No messages matching filters.');

          const lines = messages.map(m =>
            `${m.agent_emoji} ${m.agent_name} [${m.phase}]:\n${m.content}`
          );
          return ok(lines.join('\n\n---\n\n'));
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_export_session',
      'Export a session as formatted Markdown',
      { sessionId: z.string().describe('Session ID') },
      async ({ sessionId }) => {
        try {
          const s = db.getSession.get(sessionId);
          if (!s) return err(`Session ${sessionId} not found`);

          const messages = db.getSessionMessages.all(sessionId);
          const escalations = db.getSessionEscalations.all(sessionId);

          let md = `# War Room Research Session\n\n`;
          md += `**ID:** ${s.id}\n`;
          md += `**Created:** ${new Date(s.created_at).toISOString()}\n`;
          md += `**Status:** ${s.active ? 'Active' : 'Completed'}\n\n`;
          md += `## Problem\n\n${s.problem}\n\n`;
          md += `## Deliberation\n\n`;

          let currentPhase = null;
          for (const m of messages) {
            if (m.phase !== currentPhase) {
              md += `### ${m.phase}\n\n`;
              currentPhase = m.phase;
            }
            md += `#### ${m.agent_emoji} ${m.agent_name}\n\n${m.content}\n\n`;
          }

          if (escalations.length) {
            md += `## Escalations\n\n`;
            for (const e of escalations) {
              md += `**Q:** ${e.question}\n`;
              md += e.status === 'answered' ? `**A:** ${e.answer}\n\n` : `*[Pending]*\n\n`;
            }
          }
          return ok(md);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_search_sessions',
      'Search sessions by keyword in problem statement or messages',
      { query: z.string().describe('Search keyword') },
      async ({ query }) => {
        try {
          const sessions = db.searchSessions.all(`%${query}%`, `%${query}%`);
          if (!sessions.length) return ok(`No sessions matching "${query}".`);

          const lines = sessions.map(s => {
            const date = new Date(s.created_at).toISOString().slice(0, 16);
            return `[${s.id}] ${s.active ? 'Active' : 'Done'} | ${date}\n  ${s.problem.slice(0, 120)}`;
          });
          return ok(`Search "${query}" — ${sessions.length} results:\n\n${lines.join('\n\n')}`);
        } catch (e) { return err(e.message); }
      }
    );

    server.tool(
      'warroom_get_status',
      'Server health, session counts, and agent roster',
      {},
      async () => {
        try {
          const sessions = db.getSessions.all();
          const active = sessions.filter(s => s.active);
          const agents = AGENTS.map(a => `${a.emoji} ${a.name} — ${a.role}`).join('\n');
          return ok(`Status: ok\nSessions: ${sessions.length} total, ${active.length} active\n\nAgents:\n${agents}`);
        } catch (e) { return err(e.message); }
      }
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────

  function ok(text) { return { content: [{ type: 'text', text }] }; }
  function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

  // ─── Auth middleware ──────────────────────────────────────────

  function checkAuth(req, res) {
    const key = req.query.key || (req.headers.authorization || '').replace('Bearer ', '');
    if (key !== MCP_API_KEY) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return false;
    }
    return true;
  }

  // ─── Mount Streamable HTTP ────────────────────────────────────

  app.all('/mcp', async (req, res) => {
    if (!checkAuth(req, res)) return;

    const sessionId = req.headers['mcp-session-id'];

    try {
      if (sessionId && mcpSessions.has(sessionId)) {
        // Handle DELETE for existing sessions — clean up properly
        if (req.method === 'DELETE') {
          const session = mcpSessions.get(sessionId);
          mcpSessions.delete(sessionId);
          try { await session.transport.handleRequest(req, res, req.body); } catch (_) {}
          console.log(`MCP session deleted by client: ${sessionId}`);
          if (!res.headersSent) res.status(200).end();
          return;
        }
        // Existing session — reuse transport
        const session = mcpSessions.get(sessionId);
        session.lastActivityAt = Date.now();
        await session.transport.handleRequest(req, res, req.body);

        // Fix 1: Add SSE keepalive for GET requests (prevents Cloudflare 524)
        if (req.method === 'GET' && !res.writableEnded) {
          const keepaliveInterval = setInterval(() => {
            try {
              if (!res.writableEnded) {
                res.write(':keepalive\n\n');
              } else {
                clearInterval(keepaliveInterval);
              }
            } catch (e) {
              clearInterval(keepaliveInterval);
            }
          }, 25000);
          res.on('close', () => clearInterval(keepaliveInterval));
        }
        return;
      }

      if (req.method === 'POST' && !sessionId) {
        // New session — create server + transport
        const mcpServer = new McpServer({ name: 'war-room', version: '1.0.0' });
        registerTools(mcpServer);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            mcpSessions.set(sid, { transport, server: mcpServer, lastActivityAt: Date.now() });
            console.log(`MCP session created: ${sid}`);
          },
        });

        // Fix 2: Only delete session on explicit DELETE, not on SSE stream drop
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && mcpSessions.has(sid)) {
            // Check if this was triggered by a DELETE request (session should be removed)
            // vs an SSE stream drop (session should survive)
            // The SDK calls onclose when the transport is fully closed (DELETE)
            // We log it but let TTL or explicit DELETE handle cleanup
            console.log(`MCP transport onclose fired for: ${sid} (session preserved for reconnection)`);
          }
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Handle DELETE — explicit session cleanup
      if (req.method === 'DELETE' && sessionId && mcpSessions.has(sessionId)) {
        const session = mcpSessions.get(sessionId);
        mcpSessions.delete(sessionId);
        try { await session.transport.handleRequest(req, res, req.body); } catch (_) {}
        console.log(`MCP session deleted by client: ${sessionId}`);
        if (!res.headersSent) res.status(200).end();
        return;
      }

      // Session ID provided but not found, or GET/DELETE without session
      if (sessionId) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Session not found' }, id: null });
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing session ID' }, id: null });
      }
    } catch (error) {
      console.error('MCP error:', error.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
      }
    }
  });

  console.log(`MCP server mounted at /mcp?key=${MCP_API_KEY}`);
  return { MCP_API_KEY };
}

module.exports = { setupMCPServer };
