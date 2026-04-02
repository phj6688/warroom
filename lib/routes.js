const path = require('path');
const fs = require('fs');
const multer = require('multer');

function setupRoutes(app, deps) {
  const { db, stmts, AGENTS, PHASES, activeSessions, callAnthropic, createSession, loadSession, runDeliberation, broadcast, memory, quality, specialist, getAgentsForSession } = deps;

  // ─── Static & JSON ──────────────────────────────────────────
  app.use(require('express').static(path.join(__dirname, '..', 'public'), { etag: false, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));
  app.use(require('express').json({ limit: '10mb' }));

  // ─── File Upload ────────────────────────────────────────────
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
    }),
    limits: { fileSize: 10 * 1024 * 1024 }
  });

  app.post('/api/upload', upload.array('files', 10), (req, res) => {
    const files = (req.files || []).map(f => {
      const ext = path.extname(f.originalname).toLowerCase();
      const textExts = ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.css', '.sql', '.sh', '.log', '.env', '.toml', '.ini', '.cfg', '.conf', '.tex', '.rst', '.org'];
      let content = null;
      if (textExts.includes(ext)) {
        try { content = fs.readFileSync(f.path, 'utf-8').slice(0, 50000); } catch (e) { }
      }
      return { id: path.basename(f.path), name: f.originalname, size: f.size, type: f.mimetype, content };
    });
    res.json({ ok: true, files });
  });

  // ─── Improve ────────────────────────────────────────────────
  app.post('/api/improve', async (req, res) => {
    const problem = (req.body && req.body.problem || "").trim();
    if (!problem) {
      return res.status(400).json({ error: "problem required" });
    }
    const systemPrompt = process.env.IMPROVER_SYSTEM_PROMPT;
    if (!systemPrompt || !systemPrompt.trim() || systemPrompt.trim() === '__PLACEHOLDER__') {
      return res.status(503).json({ error: "Improver not configured" });
    }
    try {
      const improved = await callAnthropic(systemPrompt, [{ role: "user", content: problem }], "improver", 1000);
      return res.json({ improved });
    } catch (err) {
      console.error("Improve error:", err.message);
      return res.status(500).json({ error: "LLM call failed", detail: err.message });
    }
  });

  // ─── Health ─────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    const sc = db.prepare("SELECT COUNT(*) as count FROM sessions").get().count;
    res.json({ status: "ok", service: "war-room", sessions: sc, activeSessions: activeSessions.size, uptime: process.uptime() });
  });
  app.get('/api/health', (req, res) => {
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    res.json({ status: 'ok', service: 'war-room', sessions: sessionCount, activeSessions: activeSessions.size, uptime: process.uptime() });
  });

  // ─── Agents & Phases ───────────────────────────────────────
  app.get('/api/agents', (req, res) => {
    res.json(AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })));
  });

  app.get('/api/phases', (req, res) => {
    res.json(PHASES);
  });

  // ─── Sessions ───────────────────────────────────────────────
  app.get('/api/sessions', (req, res) => {
    const sessions = stmts.getRecentSessions.all().map(s => ({
      id: s.id, problem: s.problem, phase: s.phase,
      active: !!s.active, createdAt: s.created_at,
      messageCount: stmts.countSessionMessages.get(s.id).count
    }));
    res.json(sessions);
  });

  app.post('/api/sessions', (req, res) => {
    const { problem, files } = req.body || {};
    if (!problem) return res.status(400).json({ error: 'Problem required' });
    const session = createSession(problem, files || []);
    broadcast({ type: 'session-created', session: { id: session.id, problem: session.problem, phase: session.phase, active: session.active, createdAt: session.createdAt } });
    runDeliberation(session).catch(err => console.error('Deliberation error:', err));
    res.json({ id: session.id, problem: session.problem, phase: session.phase, active: true, createdAt: session.createdAt });
  });

  app.get('/api/search', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const sessions = db.prepare(`
      SELECT DISTINCT s.id, s.problem, s.phase, s.active, s.created_at, s.updated_at
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE LOWER(s.problem) LIKE ? OR LOWER(m.content) LIKE ?
      ORDER BY s.updated_at DESC LIMIT 20
    `).all(like, like);
    res.json(sessions.map(s => ({
      id: s.id, problem: s.problem, phase: s.phase,
      active: !!s.active, createdAt: s.created_at,
      messageCount: stmts.countSessionMessages.get(s.id).count
    })));
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // ─── Memory ────────────────────────────────────────────────
  app.get('/api/memory/similar', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q parameter required' });
    const limit = Math.min(parseInt(req.query.limit || '3', 10), 10);
    try {
      const results = await memory.retrieveSimilar(q, limit);
      res.json(results);
    } catch (err) {
      console.error('Memory search error:', err.message);
      res.status(500).json({ error: 'Memory search failed', detail: err.message });
    }
  });

  // ─── Specialists ───────────────────────────────────────────
  app.get('/api/specialists', (req, res) => {
    if (!specialist) return res.json([]);
    res.json(specialist.listTemplates());
  });

  app.get('/api/sessions/:id/agents', (req, res) => {
    const session = stmts.getSession.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // Core agents always present
    const agents = AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: false }));

    // Add session specialists from DB
    if (session.specialist_agents) {
      try {
        const specialistIds = JSON.parse(session.specialist_agents);
        for (const id of specialistIds) {
          const template = stmts.getAgentTemplateById.get(id);
          if (template) {
            agents.push({
              id: template.id, name: template.name, emoji: template.emoji,
              color: template.color, role: template.role, hat: template.hat,
              domain: template.domain, isSpecialist: true,
            });
          }
        }
      } catch (e) { /* invalid JSON, skip */ }
    }
    res.json(agents);
  });

  // ─── Quality & Shadow ──────────────────────────────────────
  app.get('/api/sessions/:id/quality', (req, res) => {
    const session = stmts.getSession.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const score = quality.getQualityScore(req.params.id);
    if (!score) return res.status(404).json({ error: 'Quality score not available yet' });
    res.json(score);
  });

  app.get('/api/sessions/:id/shadow', (req, res) => {
    const session = stmts.getSession.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const shadowAnswer = session.shadow_answer || null;
    const qualityScore = quality.getQualityScore(req.params.id);

    // Get synthesis text
    const messages = stmts.getSessionMessages.all(req.params.id);
    const synthesis = messages.filter(m => m.phase === 'Synthesis').map(m => m.content).join('\n\n');

    res.json({
      naive_answer: shadowAnswer,
      synthesis: synthesis || null,
      delta_score: qualityScore ? qualityScore.breakdown.shadow_delta : null,
    });
  });

  app.get('/api/analytics/quality', (req, res) => {
    const analytics = quality.getAnalytics();
    res.json(analytics);
  });

  // ─── Export ─────────────────────────────────────────────────
  function validateExportMode(mode) {
    const allowed = ['full_transcript', 'end_result', 'end_result_with_qa'];
    return allowed.includes(mode) ? mode : null;
  }

  function validateExportFormat(fmt) {
    const allowed = ['txt', 'json', 'md'];
    return allowed.includes(fmt) ? fmt : 'txt';
  }

  function buildExport(session, mode, format) {
    const createdAt = new Date(session.createdAt).toISOString();
    const finishedAt = session.active ? null : new Date(session.updatedAt || session.createdAt).toISOString();
    if (format === 'json') return buildJsonExport(session, mode, createdAt, finishedAt);
    return buildTextExport(session, mode, format, createdAt, finishedAt);
  }

  function buildJsonExport(session, mode, createdAt, finishedAt) {
    const base = { sessionId: session.id, problem: session.problem, mode, createdAt, finishedAt, totalPhases: PHASES.length };

    if (mode === 'full_transcript') {
      return {
        ...base,
        transcript: session.messages.map(m => ({ agent: m.agentName, emoji: m.agentEmoji, phase: m.phase, content: m.content, timestamp: new Date(m.timestamp).toISOString() })),
        questions: session.escalations.map(e => ({ askedBy: e.agentName, question: e.question, answer: e.answer || null, answered: e.answered })),
        humanMessages: (session.humanMessages || []).map(h => ({ content: h.content, timestamp: new Date(h.timestamp).toISOString() })),
      };
    }
    if (mode === 'end_result') {
      return { ...base, synthesis: session.messages.filter(m => m.phase === 'Synthesis').map(m => ({ agent: m.agentName, emoji: m.agentEmoji, content: m.content, timestamp: new Date(m.timestamp).toISOString() })) };
    }
    if (mode === 'end_result_with_qa') {
      return {
        ...base,
        synthesis: session.messages.filter(m => m.phase === 'Synthesis').map(m => ({ agent: m.agentName, emoji: m.agentEmoji, content: m.content, timestamp: new Date(m.timestamp).toISOString() })),
        questions: session.escalations.map(e => ({ askedBy: e.agentName, question: e.question, answer: e.answer || null, answered: e.answered })),
        humanMessages: (session.humanMessages || []).map(h => ({ content: h.content, timestamp: new Date(h.timestamp).toISOString() })),
      };
    }
    return base;
  }

  function hr(char, len) { return char.repeat(len || 70); }

  function buildTextExport(session, mode, format, createdAt, finishedAt) {
    const isMd = format === 'md';
    const lines = [];
    const h1 = (t) => isMd ? `# ${t}` : `${hr('═')}\n${t}\n${hr('═')}`;
    const h2 = (t) => isMd ? `## ${t}` : `\n${hr('─')}\n${t}\n${hr('─')}`;
    const h3 = (t) => isMd ? `### ${t}` : `\n── ${t} ──`;

    lines.push(h1('AI Research War Room — Export'));
    lines.push('');
    lines.push(isMd ? `**Problem:** ${session.problem}` : `Problem: ${session.problem}`);
    lines.push(isMd ? `**Session ID:** \`${session.id}\`` : `Session ID: ${session.id}`);
    lines.push(isMd ? `**Started:** ${createdAt}` : `Started: ${createdAt}`);
    if (finishedAt) lines.push(isMd ? `**Completed:** ${finishedAt}` : `Completed: ${finishedAt}`);
    lines.push(isMd ? `**Export Mode:** ${mode}` : `Export Mode: ${mode}`);
    lines.push('');

    if (mode === 'full_transcript') {
      lines.push(h2('Full Deliberation Transcript'));
      lines.push('');
      let currentPhase = null;
      for (const msg of session.messages) {
        if (msg.phase !== currentPhase) { currentPhase = msg.phase; lines.push(''); lines.push(h2(`Phase: ${currentPhase}`)); lines.push(''); }
        lines.push(h3(`${msg.agentEmoji || ''} ${msg.agentName}`));
        const ts = new Date(msg.timestamp).toLocaleTimeString('en-DE', { hour12: false });
        lines.push(isMd ? `*${ts}*` : `[${ts}]`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
      }
      if (session.escalations && session.escalations.length > 0) {
        lines.push(''); lines.push(h2('Questions & Answers')); lines.push('');
        for (const e of session.escalations) {
          lines.push(h3(`${e.agentEmoji || ''} ${e.agentName} asked:`));
          lines.push(isMd ? `> ${e.question}` : e.question);
          lines.push('');
          lines.push(e.answered && e.answer ? (isMd ? `**Answer:** ${e.answer}` : `Answer: ${e.answer}`) : (isMd ? `*[No answer provided]*` : '[No answer provided]'));
          lines.push('');
        }
      }
      if (session.humanMessages && session.humanMessages.length > 0) {
        lines.push(''); lines.push(h2('Human Messages')); lines.push('');
        for (const hm of session.humanMessages) {
          const ts = new Date(hm.timestamp).toISOString();
          lines.push(isMd ? `**[${ts}]**` : `[${ts}]`);
          lines.push(hm.content);
          lines.push('');
        }
      }
    } else if (mode === 'end_result') {
      lines.push(h2('Final Synthesis')); lines.push('');
      const synthesis = session.messages.filter(m => m.phase === 'Synthesis');
      if (synthesis.length === 0) { lines.push('_The synthesis phase has not completed yet._'); }
      else { for (const msg of synthesis) { lines.push(h3(`${msg.agentEmoji || ''} ${msg.agentName}`)); lines.push(''); lines.push(msg.content); lines.push(''); } }
    } else if (mode === 'end_result_with_qa') {
      lines.push(h2('Final Synthesis')); lines.push('');
      const synthesis = session.messages.filter(m => m.phase === 'Synthesis');
      if (synthesis.length === 0) { lines.push('_The synthesis phase has not completed yet._'); }
      else { for (const msg of synthesis) { lines.push(h3(`${msg.agentEmoji || ''} ${msg.agentName}`)); lines.push(''); lines.push(msg.content); lines.push(''); } }
      if (session.escalations && session.escalations.length > 0) {
        lines.push(''); lines.push(h2('Questions & Answers')); lines.push('');
        for (const e of session.escalations) {
          lines.push(h3(`${e.agentEmoji || ''} ${e.agentName} asked:`));
          lines.push(isMd ? `> ${e.question}` : e.question);
          lines.push('');
          lines.push(e.answered && e.answer ? (isMd ? `**Answer:** ${e.answer}` : `Answer: ${e.answer}`) : (isMd ? `*[No answer provided]*` : '[No answer provided]'));
          lines.push('');
        }
      }
      if (session.humanMessages && session.humanMessages.length > 0) {
        lines.push(''); lines.push(h2('Human Messages')); lines.push('');
        for (const hm of session.humanMessages) {
          const ts = new Date(hm.timestamp).toISOString();
          lines.push(isMd ? `**[${ts}]**` : `[${ts}]`);
          lines.push(hm.content);
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  app.get('/api/sessions/:id/export', (req, res) => {
    const { id } = req.params;
    if (!/^[a-z0-9]{6,32}$/i.test(id)) return res.status(400).json({ error: 'Invalid session id' });
    const mode = validateExportMode(req.query.mode) || 'full_transcript';
    const format = validateExportFormat(req.query.format);
    const session = loadSession(id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const sessionRow = stmts.getSession.get(id);
    session.updatedAt = sessionRow ? sessionRow.updated_at : session.createdAt;
    try {
      const exportData = buildExport(session, mode, format);
      const modeSlug = mode.replace(/_/g, '-');
      const filename = `war-room-${id}-${modeSlug}.${format}`;
      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.json(exportData);
      }
      const mimeType = format === 'md' ? 'text/markdown' : 'text/plain';
      res.setHeader('Content-Type', `${mimeType}; charset=utf-8`);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(exportData);
    } catch (err) {
      console.error('Export error:', err);
      return res.status(500).json({ error: 'Export failed', detail: err.message });
    }
  });

  app.get('/api/sessions/:id/export/options', (req, res) => {
    const { id } = req.params;
    if (!/^[a-z0-9]{6,32}$/i.test(id)) return res.status(400).json({ error: 'Invalid session id' });
    const sessionRow = stmts.getSession.get(id);
    if (!sessionRow) return res.status(404).json({ error: 'Session not found' });
    const messageCount = db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(id).c;
    const synthesisCount = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND phase = 'Synthesis'").get(id).c;
    const qaCount = db.prepare('SELECT COUNT(*) as c FROM escalations WHERE session_id = ?').get(id).c;
    const isComplete = !sessionRow.active;
    res.json({
      sessionId: id, problem: sessionRow.problem, isComplete, messageCount,
      hasSynthesis: synthesisCount > 0, hasQA: qaCount > 0,
      modes: [
        { id: 'full_transcript', label: 'Full Transcript (A to Z)', description: 'Every agent message from all phases, questions & answers, and human messages', available: messageCount > 0 },
        { id: 'end_result', label: 'End Result Only', description: 'Final synthesis from the Process Architect only', available: synthesisCount > 0 },
        { id: 'end_result_with_qa', label: 'End Result + Questions & Answers', description: 'Final synthesis plus all escalation Q&A and human messages', available: synthesisCount > 0 || qaCount > 0 },
      ],
      formats: [
        { id: 'txt', label: 'Plain Text (.txt)', mimeType: 'text/plain' },
        { id: 'md', label: 'Markdown (.md)', mimeType: 'text/markdown' },
        { id: 'json', label: 'JSON (.json)', mimeType: 'application/json' },
      ],
    });
  });
}

module.exports = { setupRoutes };
