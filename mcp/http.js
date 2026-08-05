const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const crypto = require('crypto');
const { registerTools } = require('./tools.js');
const { buildDecisionRecord } = require('../lib/decision-record');
const appConfig = require('../lib/app-config');
const { mergeRouting } = require('../lib/agent-routing');
const { availableRoutes, resolveRoute, testConnection } = require('../lib/llm');
const { listPresets, getPreset } = require('../lib/presets');
const { resumeSession } = require('../lib/resume');
const { improverSystemPrompt, improverUserMessage } = require('../lib/improve');
const { buildJsonExport } = require('../lib/export');
const { embed } = require('../lib/embeddings');

const MCP_API_KEY = process.env.MCP_API_KEY || crypto.randomBytes(32).toString('hex');
process.env.MCP_API_KEY = MCP_API_KEY;

// Constant-time key comparison. crypto.timingSafeEqual requires equal-length
// buffers, so guard on length first (a length mismatch is trivially unequal and
// leaks only the length, not the contents).
function keysMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Format post-migration-013 session_files rows for a prompt. After migration
// 013 these rows hold file_id references plus denormalized metadata, not inline
// content (the content lives in files-service); surface honest metadata rather
// than the old "FILE: undefined\n[binary]" placeholder produced by reading the
// pre-013 columns f.name / f.content.
function formatAttachedFiles(files) {
  return (files || [])
    .map(f => `FILE: ${f.file_name} (${f.file_tokens} tokens, ${f.file_mime})`)
    .join('\n\n');
}

function setupMCPServer(app, deps) {
  const { db, stmts, callLLM, createSession, loadSession, runDeliberation, activeSessions, AGENTS, PHASES, filesServiceClient, attachFiles, abortSessionWaits, quality, memory, specialist, getAgentsForSession, broadcast, broadcastGlobal, log } = deps;

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
    async getDecisionRecord(sessionId) {
      return buildDecisionRecord(stmts, sessionId);
    },
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
          outcome: s.outcome ?? null,
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
        outcome: s.outcome ?? null,
        qualityScore: s.quality_score ?? null,
        costBreakdown: (function (j) { if (!j) return null; try { return JSON.parse(j); } catch { return null; } })(s.cost_breakdown),
        tokenBreakdown: (function (j) { if (!j) return null; try { return JSON.parse(j); } catch { return null; } })(s.token_breakdown),
        messages: messages.map(m => ({ agentEmoji: m.agent_emoji, agentName: m.agent_name, phase: m.phase, content: m.content })),
        escalations: escalations.map(e => ({ id: e.id, agentName: e.agent_name, question: e.question, answer: e.answer, answered: e.status === 'answered' })),
        humanMessages: humanMsgs.map(h => ({ content: h.content })),
      };
    },
    async createSession(problem, files, fileIds, presetId, continuesFromSessionId) {
      const ids = Array.isArray(fileIds) ? [...fileIds] : [];
      if (files && files.length) {
        const uploaded = await uploadInlineFiles(files);
        ids.push(...uploaded);
      }
      // createSession() treats an unknown preset id as "no preset". Rejecting it
      // here instead means a typo comes back as an error rather than silently
      // producing a generalist run the caller did not ask for.
      if (presetId && !getPreset(presetId)) {
        throw new Error(`unknown preset: ${presetId} (known: ${listPresets().map(p => p.id).join(', ')})`);
      }
      if (continuesFromSessionId && !stmts.getSession.get(continuesFromSessionId)) {
        throw new Error(`prior session ${continuesFromSessionId} not found`);
      }
      const session = await createSession(problem, ids, presetId || null, continuesFromSessionId || null);
      runDeliberation(session).catch(e => console.error('MCP deliberation error:', e.message));
      return {
        id: session.id, problem: session.problem, fileIds: ids,
        presetId: session.presetId || null,
        continuesFromSessionId: session.continuesFromSessionId || null,
      };
    },
    async listPresets() {
      return listPresets();
    },
    async resumeSession(sessionId) {
      const result = resumeSession(
        { stmts, AGENTS, PHASES, activeSessions, loadSession, runDeliberation, specialist, getAgentsForSession, broadcast, broadcastGlobal, log },
        sessionId,
      );
      if (result.error) throw new Error(result.error);
      return { sessionId: result.session.id, resumedFromPhase: result.resumePhase };
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
      // Stop a running deliberation before deleting so its next insertMessage
      // does not violate the foreign key against the now-deleted row.
      const running = activeSessions.get(sessionId);
      if (running) {
        running.active = false;
        activeSessions.delete(sessionId);
        abortSessionWaits(sessionId, 'session deleted');
      }
      stmts.deleteSession.run(sessionId);
    },
    async stopSession(sessionId) {
      const session = activeSessions.get(sessionId);
      if (session) {
        session.active = false;
        stmts.updateSessionActive.run(0, Date.now(), sessionId);
        activeSessions.delete(sessionId);
        // Release any deliberation parked on an escalation wait so the loop
        // can fall through and exit (parity with the WS stop path).
        abortSessionWaits(sessionId, 'session stopped via MCP');
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
        userContent += formatAttachedFiles(files) + '\n\n';
      }
      userContent += `FULL DELIBERATION:\n${context}\n\nHUMAN QUESTION:\n${question}\n\nProvide a comprehensive answer.`;
      return await callLLM(systemPrompt, [{ role: 'user', content: userContent }], 'process-architect');
    },
    async exportSession(sessionId, mode = 'full_transcript', format = 'md') {
      const s = stmts.getSession.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      // json reuses the HTTP export's shape so a programmatic caller gets the
      // same object over either transport. The markdown path below is MCP's own
      // and stays byte-identical to what callers already parse.
      if (format === 'json') {
        const session = loadSession(sessionId);
        if (!session) throw new Error(`Session ${sessionId} not found`);
        const createdAt = new Date(session.createdAt).toISOString();
        const finishedAt = s.active ? null : new Date(s.updated_at || session.createdAt).toISOString();
        return JSON.stringify(buildJsonExport(session, mode, createdAt, finishedAt, PHASES.length), null, 2);
      }
      const messages = stmts.getSessionMessages.all(sessionId);
      const escalations = stmts.getSessionEscalations.all(sessionId);
      // Additive: an omitted / unknown mode falls through to the full transcript
      // below, byte-for-byte unchanged. end_result surfaces just the verdict.
      if (mode === 'end_result' || mode === 'end_result_with_qa') {
        const synthesis = messages.filter(m => m.phase === 'Synthesis');
        let out = `# War Room Research Session\n\n**ID:** ${s.id}\n\n## Final Synthesis\n\n`;
        if (synthesis.length === 0) out += `_The synthesis phase has not completed yet._\n\n`;
        else for (const m of synthesis) out += `#### ${m.agent_emoji} ${m.agent_name}\n\n${m.content}\n\n`;
        if (mode === 'end_result_with_qa' && escalations.length) {
          out += `## Escalations\n\n`;
          for (const e of escalations) {
            out += `**Q:** ${e.question}\n`;
            out += e.status === 'answered' ? `**A:** ${e.answer}\n\n` : `*[Pending]*\n\n`;
          }
        }
        return out;
      }
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
      return AGENTS.map(a => ({ id: a.id, emoji: a.emoji, name: a.name, role: a.role, hat: a.hat }));
    },

    // ─── Model / provider routing (server-wide, same store as the UI) ────
    async getModelConfig() {
      const configured = appConfig.getAgentRouting();
      const agents = AGENTS.map(a => {
        const eff = resolveRoute(a.id);
        return {
          id: a.id, name: a.name, emoji: a.emoji, role: a.role,
          configured: configured[a.id] || null,
          effective: { route: eff.route, model: eff.model },
        };
      });
      return { routes: appConfig.ROUTES, available: availableRoutes(), agents };
    },

    // agentId 'all' writes the same pair to every agent, mirroring the Settings
    // panel's Apply-to-all. clear drops the override so the agent falls back to
    // the deployment's env default.
    async setModel({ agentId, route, model, clear }) {
      const validIds = new Set(AGENTS.map(a => a.id));
      const targets = agentId === 'all' ? [...validIds] : [agentId];
      for (const id of targets) {
        if (!validIds.has(id)) throw new Error(`unknown agent: ${id} (use warroom_list_agents for valid ids, or "all")`);
      }
      const patch = {};
      for (const id of targets) patch[id] = clear ? null : { route, model };
      const { clean, error } = mergeRouting(appConfig.getAgentRouting(), patch, validIds, appConfig.ROUTES);
      if (error) throw new Error(error);
      appConfig.set('agent_routing', clean);
      return { routing: clean, changed: targets };
    },

    async testModel({ route, model }) {
      if (route && !model) throw new Error('a non-default route requires an explicit model');
      return testConnection({ route: route || '', model: model || '' });
    },

    // ─── Quality, memory, intake ─────────────────────────────────────────
    async rateSession(sessionId, rating) {
      if (!['USEFUL', 'PARTIAL', 'MISLEADING'].includes(rating)) {
        throw new Error('rating must be USEFUL, PARTIAL, or MISLEADING');
      }
      if (!stmts.getSession.get(sessionId)) throw new Error(`Session ${sessionId} not found`);
      stmts.updateSessionSynthesisQuality.run(rating, Date.now(), sessionId);
      return { sessionId, rating };
    },

    async getQuality(sessionId) {
      const s = stmts.getSession.get(sessionId);
      if (!s) throw new Error(`Session ${sessionId} not found`);
      const score = quality ? quality.getQualityScore(sessionId) : null;
      const messages = stmts.getSessionMessages.all(sessionId);
      const synthesis = messages.filter(m => m.phase === 'Synthesis').map(m => m.content).join('\n\n');
      return {
        sessionId,
        score: score ? score.score : null,
        breakdown: score ? score.breakdown : null,
        evaluatorModel: score ? score.evaluator_model : null,
        humanRating: s.synthesis_quality || null,
        shadowAnswer: s.shadow_answer || null,
        hasSynthesis: !!synthesis,
      };
    },

    async getAnalytics() {
      if (!quality) throw new Error('quality analytics unavailable on this server');
      return quality.getAnalytics();
    },

    async semanticSearch(query, limit) {
      const k = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);
      const vec = await embed(query);
      // Embeddings are optional infrastructure (Ollama). Say so rather than
      // returning an empty list a caller would read as "no similar sessions".
      if (!vec) throw new Error('semantic search unavailable — the embedding backend is not reachable; use warroom_search_sessions for keyword search');
      const rows = db.prepare('SELECT rowid, distance FROM session_embeddings WHERE embedding MATCH ? AND k = ?').all(vec, k * 2);
      const seen = new Map();
      for (const row of rows) {
        const meta = stmts.getEmbeddingMetaByRowid.get(row.rowid);
        if (meta && !seen.has(meta.session_id)) seen.set(meta.session_id, 1 / (1 + row.distance));
      }
      const results = [];
      for (const [sessionId, similarity] of seen) {
        const s = stmts.getSession.get(sessionId);
        if (s) results.push({ id: s.id, problem: s.problem, active: !!s.active, createdAt: s.created_at, similarity });
        if (results.length >= k) break;
      }
      results.sort((a, b) => b.similarity - a.similarity);
      return results;
    },

    async recallSimilar(query, limit) {
      if (!memory) throw new Error('memory unavailable on this server');
      const k = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 10);
      return memory.retrieveSimilar(query, k);
    },

    async improveProblem(problem) {
      const systemPrompt = improverSystemPrompt();
      if (!systemPrompt) throw new Error('Improver not configured on this server');
      return callLLM(systemPrompt, [{ role: 'user', content: improverUserMessage(problem) }], 'improver', 1000);
    },

    async listSpecialists() {
      if (!specialist) return [];
      return specialist.listTemplates();
    },

    async getSessionAgents(sessionId) {
      const session = stmts.getSession.get(sessionId);
      if (!session) throw new Error(`Session ${sessionId} not found`);
      const agents = AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, role: a.role, hat: a.hat, isSpecialist: false }));
      if (session.specialist_agents) {
        try {
          for (const id of JSON.parse(session.specialist_agents)) {
            const t = stmts.getAgentTemplateById.get(id);
            if (t) agents.push({ id: t.id, name: t.name, emoji: t.emoji, role: t.role, hat: t.hat, domain: t.domain, isSpecialist: true });
          }
        } catch (_) { /* invalid JSON, core agents only */ }
      }
      return agents;
    },

    async getPhases() {
      return PHASES.map((p, i) => ({ index: i, id: p.id, name: p.name, agents: p.agents }));
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
    if (!keysMatch(key, MCP_API_KEY)) {
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

  // Never print the key: this line lands in docker logs on a public-repo app.
  console.log('MCP server mounted at /mcp (auth required: MCP_API_KEY via ?key= or Authorization: Bearer)');
  return { MCP_API_KEY };
}

module.exports = { setupMCPServer, formatAttachedFiles };
