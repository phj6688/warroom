const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const crypto = require('crypto');
const { registerTools } = require('./tools.js');

const MCP_API_KEY = process.env.MCP_API_KEY || crypto.randomBytes(32).toString('hex');
process.env.MCP_API_KEY = MCP_API_KEY;

function setupMCPServer(app, deps) {
  const { db, stmts, callLLM, createSession, runDeliberation, activeSessions, AGENTS, PHASES, filesServiceClient, attachFiles } = deps;

  function inferMime(name) {
    const ext = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    const map = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sql: 'text/x-sql', log: 'text/plain' };
    return map[ext] || 'text/plain';
  }

  async function uploadInlineFiles(files) {
    if (!filesServiceClient) throw new Error('files-service is not configured on this server — file attachment unavailable');
    const buffers = files.map(f => ({ buffer: Buffer.from(f.content, 'utf8'), name: f.name, mime: inferMime(f.name) }));
    const result = await filesServiceClient.uploadFiles(buffers);
    const items = Array.isArray(result) ? result : (result?.files || result?.items || []);
    if (!items.length) throw new Error('files-service upload returned no items');
    return items.map(it => it.id || it.file_id);
  }

  const mcpSessions = new Map();

  function isInitializeBody(body) {
    if (!body) return false;
    const msgs = Array.isArray(body) ? body : [body];
    return msgs.some(m => m && m.method === 'initialize');
  }

  async function startNewTransport(req, res) {
    const mcpServer = new McpServer({ name: 'war-room', version: '1.0.0' });
    registerTools(mcpServer, ops);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        mcpSessions.set(sid, { transport, server: mcpServer });
        console.log(`MCP session created: ${sid}`);
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && mcpSessions.has(sid)) {
        console.log(`MCP transport onclose fired for: ${sid} (session preserved for reconnection)`);
      }
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  // ─── Ops adapter: direct DB access ────────────────────────
  const ops = {
    async listSessions() {
      return stmts.getSessions.all().map(s => {
        const msgs = stmts.getSessionMessages.all(s.id);
        const pending = stmts.getPendingEscalations.all(s.id);
        return {
          id: s.id, problem: s.problem, phase: s.phase,
          phaseName: PHASES[s.phase]?.name || String(s.phase),
          active: !!s.active, messageCount: msgs.length, pendingCount: pending.length,
          createdAt: s.created_at,
          totalTokens: s.total_tokens ?? null,
          totalCostUsd: s.total_cost_usd ?? null,
        };
      });
    },
    async getSession(sessionId) {
      const s = stmts.getSession.get(sessionId);
      if (!s) return null;
      const messages = stmts.getSessionMessages.all(sessionId);
      const escalations = stmts.getSessionEscalations.all(sessionId);
      const humanMsgs = stmts.getSessionHumanMessages.all(sessionId);
      return {
        id: s.id, problem: s.problem, phase: s.phase,
        phaseName: PHASES[s.phase]?.name || String(s.phase),
        active: !!s.active, createdAt: s.created_at,
        totalTokens: s.total_tokens ?? null,
        totalCostUsd: s.total_cost_usd ?? null,
        tokenBreakdown: (function (j) { if (!j) return null; try { return JSON.parse(j); } catch { return null; } })(s.token_breakdown),
        messages: messages.map(m => ({ agentEmoji: m.agent_emoji, agentName: m.agent_name, phase: m.phase, content: m.content })),
        escalations: escalations.map(e => ({ id: e.id, agentName: e.agent_name, question: e.question, answer: e.answer, answered: e.status === 'answered' })),
        humanMessages: humanMsgs.map(h => ({ content: h.content })),
      };
    },
    async createSession(problem, files, fileIds) {
      const ids = Array.isArray(fileIds) ? [...fileIds] : [];
      if (files && files.length) {
        const uploaded = await uploadInlineFiles(files);
        ids.push(...uploaded);
      }
      const session = await createSession(problem, ids);
      runDeliberation(session).catch(e => console.error('MCP deliberation error:', e.message));
      return { id: session.id, problem: session.problem, fileIds: ids };
    },
    async attachFiles(sessionId, files, fileIds) {
      const ids = Array.isArray(fileIds) ? [...fileIds] : [];
      if (files && files.length) {
        const uploaded = await uploadInlineFiles(files);
        ids.push(...uploaded);
      }
      if (!ids.length) throw new Error('No files or file_ids provided');
      const attached = await attachFiles(sessionId, ids);
      return { sessionId, fileIds: ids, attached };
    },
    async deleteSession(sessionId) {
      const s = stmts.getSession.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      stmts.deleteSession.run(sessionId);
      activeSessions.delete(sessionId);
    },
    async stopSession(sessionId) {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.active = false;
        stmts.updateSessionActive.run(0, Date.now(), sessionId);
        activeSessions.delete(sessionId);
      }
    },
    async sendMessage(sessionId, message) {
      const session = activeSessions.get(sessionId);
      if (!session) throw new Error(`No active session ${sessionId}`);
      const now = Date.now();
      const hmId = crypto.randomUUID();
      const hm = { id: hmId, content: message, timestamp: now };
      if (session.humanMessages) session.humanMessages.push(hm);
      stmts.insertHumanMessage.run(hmId, sessionId, message, now);
    },
    async answerEscalation(escalationId, answer) {
      stmts.answerEscalation.run(answer, Date.now(), escalationId);
      for (const [, session] of activeSessions) {
        const esc = session.escalations?.find(e => e.id === escalationId);
        if (esc) { esc.answered = true; esc.answer = answer; break; }
      }
    },
    async getEscalations(sessionId) {
      if (sessionId) return stmts.getPendingEscalations.all(sessionId);
      return stmts.getAllPendingEscalations.all();
    },
    async getMessages(sessionId, agentId, phase) {
      let messages = stmts.getSessionMessages.all(sessionId);
      if (agentId) messages = messages.filter(m => m.agent_id === agentId);
      if (phase) messages = messages.filter(m => m.phase === phase);
      return messages;
    },
    async askQuestion(sessionId, question) {
      const s = stmts.getSession.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      const messages = stmts.getSessionMessages.all(sessionId);
      let files = [];
      try { files = stmts.getSessionFiles.all(sessionId); } catch (_) {}
      const architect = AGENTS.find(a => a.id === 'process-architect');
      const context = messages.map(m => `[${m.agent_name}]: ${m.content}`).join('\n\n');
      const systemPrompt = architect.systemPrompt + '\n\nYou are in Q&A mode. Answer the human\'s follow-up question based on the full deliberation context.';
      let userContent = `ORIGINAL PROBLEM:\n${s.problem}\n\n`;
      if (files.length) {
        userContent += files.map(f => `FILE: ${f.name}\n${f.content || '[binary]'}`).join('\n\n') + '\n\n';
      }
      userContent += `FULL DELIBERATION:\n${context}\n\nHUMAN QUESTION:\n${question}\n\nProvide a comprehensive answer.`;
      return await callLLM(systemPrompt, [{ role: 'user', content: userContent }], 'process-architect');
    },
    async exportSession(sessionId) {
      const s = stmts.getSession.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      const messages = stmts.getSessionMessages.all(sessionId);
      const escalations = stmts.getSessionEscalations.all(sessionId);
      let md = `# War Room Research Session\n\n`;
      md += `**ID:** ${s.id}\n`;
      md += `**Created:** ${new Date(s.created_at).toISOString()}\n`;
      md += `**Status:** ${s.active ? 'Active' : 'Completed'}\n\n`;
      md += `## Problem\n\n${s.problem}\n\n`;
      md += `## Deliberation\n\n`;
      let currentPhase = null;
      for (const m of messages) {
        if (m.phase !== currentPhase) { md += `### ${m.phase}\n\n`; currentPhase = m.phase; }
        md += `#### ${m.agent_emoji} ${m.agent_name}\n\n${m.content}\n\n`;
      }
      if (escalations.length) {
        md += `## Escalations\n\n`;
        for (const e of escalations) {
          md += `**Q:** ${e.question}\n`;
          md += e.status === 'answered' ? `**A:** ${e.answer}\n\n` : `*[Pending]*\n\n`;
        }
      }
      return md;
    },
    async searchSessions(query) {
      return stmts.searchSessions.all(`%${query}%`, `%${query}%`).map(s => ({
        id: s.id, problem: s.problem, active: !!s.active, createdAt: s.created_at,
      }));
    },
    async listAgents() {
      return AGENTS.map(a => ({ emoji: a.emoji, name: a.name, role: a.role, hat: a.hat }));
    },
    async getStatus() {
      const sessions = stmts.getSessions.all();
      const active = sessions.filter(s => s.active);
      const agents = AGENTS.map(a => `${a.emoji} ${a.name} — ${a.role}`).join('\n');
      return `Status: ok\nSessions: ${sessions.length} total, ${active.length} active\n\nAgents:\n${agents}`;
    },
  };

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
        if (req.method === 'DELETE') {
          const session = mcpSessions.get(sessionId);
          mcpSessions.delete(sessionId);
          try { await session.transport.handleRequest(req, res, req.body); } catch (_) {}
          console.log(`MCP session deleted by client: ${sessionId}`);
          if (!res.headersSent) res.status(200).end();
          return;
        }
        const session = mcpSessions.get(sessionId);
        await session.transport.handleRequest(req, res, req.body);
        if (req.method === 'GET' && !res.writableEnded) {
          const keepaliveInterval = setInterval(() => {
            try {
              if (!res.writableEnded) { res.write(':keepalive\n\n'); } else { clearInterval(keepaliveInterval); }
            } catch (e) { clearInterval(keepaliveInterval); }
          }, 25000);
          res.on('close', () => clearInterval(keepaliveInterval));
        }
        return;
      }

      if (req.method === 'POST' && isInitializeBody(req.body)) {
        if (sessionId) {
          console.log(`MCP re-initialize with stale session id: ${sessionId} (starting fresh transport)`);
        }
        await startNewTransport(req, res);
        return;
      }

      if (req.method === 'POST' && !sessionId) {
        await startNewTransport(req, res);
        return;
      }

      if (sessionId) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
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
