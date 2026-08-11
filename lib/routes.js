const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { embed } = require('./embeddings');
const { requireAuth } = require('./auth');
const { log, withRequest } = require('./logger');
const { buildDecisionRecord } = require('./decision-record');
const {
  httpCreateSessionBody,
  httpAttachFilesBody,
  httpResumeSessionBody,
  httpImproveBody,
  httpPinBody,
  httpTestConnectionBody,
} = require('./validation');
const { resumeSession } = require('./resume');
const { improverSystemPrompt, improverUserMessage } = require('./improve');
const { buildJsonExport } = require('./export');
const { listPresets } = require('./presets');
const appConfig = require('./app-config');
const { sanitizeRouting } = require('./agent-routing');
const { availableRoutes, resolveRoute, testConnection, listModels } = require('./llm');
const { DEFAULT_PRICING, DEFAULT_SUBSCRIPTION, DEFAULT_ELECTRICITY } = require('./cost');

// F5 — express middleware factory: parse req.body through a zod schema and
// reject with a 400 + structured error array on failure.
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      return res.status(400).json({
        error: 'validation_failed',
        issues: result.error.issues,
      });
    }
    req.body = result.data;
    next();
  };
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

// F16 — counts come from the joined row produced by getRecentSessions. Rows
// from getSession (single-session lookup) do not carry the joined columns,
// so fall back to the prepared stmts in that path. The /api/sessions list
// route always uses the joined form and never hits the fallback.
function enrichSession(s, stmts) {
  const messageCount = (s.message_count != null)
    ? s.message_count
    : stmts.messageCountForSession.get(s.id).c;
  const escalationCount = (s.escalation_count != null)
    ? s.escalation_count
    : stmts.escalationCountForSession.get(s.id).c;
  return {
    id: s.id, problem: s.problem, phase: s.phase, active: !!s.active,
    createdAt: s.created_at, updatedAt: s.updated_at,
    qualityScore: s.quality_score ?? null,
    archetypeId: s.archetype_id || null,
    specialistAgents: safeParse(s.specialist_agents, []),
    messageCount,
    escalationCount,
    pinned: !!s.pinned,
    crashRecovered: !!s.crash_recovered_at,
    totalTokens: s.total_tokens ?? null,
    tokenBreakdown: safeParse(s.token_breakdown, null),
    totalCostUsd: s.total_cost_usd ?? null,
    costBreakdown: safeParse(s.cost_breakdown, null),
  };
}

function setupRoutes(app, deps) {
  const { db, stmts, AGENTS, PHASES, activeSessions, callAnthropic, createSession, loadSession, runDeliberation, broadcast, broadcastGlobal, memory, quality, specialist, getAgentsForSession, attachFiles, filesServiceClient } = deps;

  // ─── Build beacon ───────────────────────────────────────────
  // index.html is a static file, so the commit cannot be baked in at build
  // time. Injecting it here lets a screenshot harness read the build out of the
  // rendered document and prove the page it captured came from this deploy.
  // Mounted ahead of express.static so it wins for the document itself; every
  // other asset falls through untouched, and the auth posture is unchanged
  // because express.static already served index.html at this point in the chain.
  app.get(['/', '/index.html'], (req, res, next) => {
    // A commit has a known shape, so validate rather than escape: anything that
    // is not a hex sha is dropped instead of being sanitised into the document.
    const sha = process.env.BUILD_SHA;
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) return next();
    fs.readFile(path.join(__dirname, '..', 'public', 'index.html'), 'utf-8', (err, html) => {
      if (err || !html.includes('<head>')) return next();
      res.set('Cache-Control', 'no-store');
      res.type('html').send(
        html.replace('<head>', `<head>\n<meta name="x-build-sha" content="${sha}">`)
      );
    });
  });

  // ─── Static & JSON ──────────────────────────────────────────
  app.use(require('express').static(path.join(__dirname, '..', 'public'), { etag: false, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));
  app.use(require('express').json({ limit: '10mb' }));

  // ─── Auth gate (F1 / S01) ───────────────────────────────────
  // Bearer auth on every endpoint reaching this layer. /health is the
  // single intentional bypass (Docker health check). Static assets are
  // served by the express.static handler above and never reach here.
  app.use((req, res, next) =>
    (req.path === '/health' || req.path === '/metrics') ? next() : requireAuth(req, res, next)
  );

  // F9 — request-id middleware. Honor an upstream X-Request-ID if the
  // operator has put a reverse proxy in front, otherwise generate one. Every
  // route handler can use req.log to emit JSON lines tagged with reqId.
  app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-ID', req.id);
    req.log = withRequest(req.id);
    next();
  });

  // ─── Files-Service Config ────────────────────────────────────
  // The browser only needs to know files-service is configured and where to
  // reach it; it uploads through POST /api/files/upload, which injects the
  // token server-side. Never return FILES_SERVICE_TOKEN here: this route is
  // reachable by any caller when WAR_ROOM_TOKEN is unset, so shipping the token
  // would hand a live credential to an anonymous caller (HLB-796).
  app.get('/api/files-service-config', (req, res) => {
    const url = process.env.FILES_SERVICE_URL;
    const token = process.env.FILES_SERVICE_TOKEN;
    if (!url || !token) return res.status(503).json({ error: 'files-service not configured' });
    res.json({ url });
  });

  // ─── Files-Service Upload Proxy ──────────────────────────────
  // Transparent proxy so the browser doesn't need direct network access
  // to files-service (Tailscale IP unreachable from most browsers).
  // War-room pipes the multipart body through without processing it.
  app.post('/api/files/upload', async (req, res) => {
    const fsUrl = process.env.FILES_SERVICE_URL;
    const fsToken = process.env.FILES_SERVICE_TOKEN;
    if (!fsUrl || !fsToken) return res.status(503).json({ error: 'files-service not configured' });
    try {
      const proxyRes = await fetch(`${fsUrl}/v1/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${fsToken}`,
          ...(req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {}),
        },
        body: req,
        duplex: 'half',
      });
      const data = await proxyRes.json();
      res.status(proxyRes.status).json(data);
    } catch (err) {
      req.log.error({ err: err.message }, 'files-service proxy error');
      res.status(502).json({ error: 'files-service unreachable' });
    }
  });

  // ─── Improve ────────────────────────────────────────────────
  app.post('/api/improve', validateBody(httpImproveBody), async (req, res) => {
    const problem = req.body.problem.trim();
    if (!problem) {
      return res.status(400).json({ error: "problem required" });
    }
    const systemPrompt = improverSystemPrompt();
    if (!systemPrompt) {
      return res.status(503).json({ error: "Improver not configured" });
    }
    try {
      const improved = await callAnthropic(systemPrompt, [{ role: "user", content: improverUserMessage(problem) }], "improver");
      return res.json({ improved });
    } catch (err) {
      req.log.error({ err: err.message }, 'improve error');
      return res.status(500).json({ error: "LLM call failed", detail: err.message });
    }
  });

  // ─── Health ─────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    const sc = stmts.countAllSessions.get().count;
    res.json({ status: "ok", service: "war-room", sessions: sc, activeSessions: activeSessions.size, uptime: process.uptime() });
  });
  app.get('/api/health', (req, res) => {
    const sessionCount = stmts.countAllSessions.get().count;
    res.json({ status: 'ok', service: 'war-room', sessions: sessionCount, activeSessions: activeSessions.size, uptime: process.uptime() });
  });

  // HLB-899 — minimal Prometheus-text metrics for a scrape / alert. Counts only,
  // no secrets; auth-exempt like /health so a probe can read it.
  // deliberations_failed_total surfaces the B7 (HLB-797) failed-run signal.
  app.get('/metrics', (req, res) => {
    const total = stmts.countAllSessions.get().count;
    const failed = stmts.countFailedSessions.get().count;
    const lines = [
      '# HELP war_room_sessions_total Total deliberation sessions recorded.',
      '# TYPE war_room_sessions_total gauge',
      `war_room_sessions_total ${total}`,
      '# HELP war_room_sessions_active Currently running deliberations.',
      '# TYPE war_room_sessions_active gauge',
      `war_room_sessions_active ${activeSessions.size}`,
      '# HELP war_room_deliberations_failed_total Deliberations that ended with outcome=failed (every agent turn errored).',
      '# TYPE war_room_deliberations_failed_total gauge',
      `war_room_deliberations_failed_total ${failed}`,
      '# HELP war_room_uptime_seconds Process uptime in seconds.',
      '# TYPE war_room_uptime_seconds gauge',
      `war_room_uptime_seconds ${Math.floor(process.uptime())}`,
      '',
    ];
    res.type('text/plain').send(lines.join('\n'));
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
    const sessions = stmts.getRecentSessions.all().map(s => enrichSession(s, stmts));
    res.json(sessions);
  });

  // Role presets — the landing picker fetches these to swap examples and seed
  // specialists. Generalist (no preset) is the implicit default, not listed.
  app.get('/api/presets', (req, res) => {
    res.json(listPresets());
  });

  // ─── Settings: per-agent model + provider routing (HLB-336) ─────────────
  // The Settings panel reads this to render one row per agent. `effective` is
  // what each agent resolves to right now (config or env default), so the UI
  // can show a meaningful placeholder even with nothing configured. `available`
  // flags which routes have credentials in this deployment.
  app.get('/api/settings/agent-routing', (req, res) => {
    const agents = (AGENTS || []).map(a => ({ id: a.id, name: a.name, emoji: a.emoji, role: a.role }));
    const effective = {};
    for (const a of agents) { const r = resolveRoute(a.id); effective[a.id] = { route: r.route, model: r.model }; }
    res.json({ agents, routes: appConfig.ROUTES, available: availableRoutes(), routing: appConfig.getAgentRouting(), effective });
  });

  // Persist per-agent overrides. Body: { routing: { agentId: { route?, model? } } }.
  // Empty entries are dropped so an agent reverts to the env default. Applies
  // immediately (the cache is write-through); no restart needed.
  app.put('/api/settings/agent-routing', (req, res) => {
    const validIds = new Set((AGENTS || []).map(a => a.id));
    const { clean, error } = sanitizeRouting(req.body && req.body.routing, validIds, appConfig.ROUTES);
    if (error) return res.status(400).json({ error });
    appConfig.set('agent_routing', clean);
    res.json({ ok: true, routing: clean });
  });

  // Fire a 1-token completion at a route+model pair so the panel can prove a
  // typed model id resolves and the provider answers, before Save. Always
  // 200 with { ok, route, model, latencyMs, error? }: a provider failure is
  // the endpoint's answer, not an endpoint failure. 400 only for an invalid
  // request shape (mirrors the agent-routing PUT's non-default-route rule).
  app.post('/api/settings/test-connection', validateBody(httpTestConnectionBody), async (req, res) => {
    const { route, model } = req.body;
    if (route && !model) {
      return res.status(400).json({ error: 'a non-default route requires an explicit model' });
    }
    res.json(await testConnection({ route, model }));
  });

  // Model catalog: the ids the route's provider actually serves, fetched live
  // from the provider so the panel and MCP clients can offer real choices.
  // Blank route means the deployment default. Provider failures come back as
  // 200 { ok:false, error } like test-connection; only an unknown route 400s.
  app.get('/api/settings/models', async (req, res) => {
    const route = typeof req.query.route === 'string' ? req.query.route : '';
    if (route && !appConfig.ROUTES.includes(route)) {
      return res.status(400).json({ error: `unknown route: ${route}` });
    }
    res.json(await listModels({ route }));
  });

  // ─── Settings: cost / pricing config (HLB-337) ──────────────────────────
  // Effective config (configured value or the seeded default) plus the defaults
  // so the Settings panel can show what each field falls back to.
  app.get('/api/settings/cost', (req, res) => {
    res.json({
      pricing: appConfig.get('pricing', null) ?? DEFAULT_PRICING,
      subscription: appConfig.get('subscription', null) ?? DEFAULT_SUBSCRIPTION,
      electricity: appConfig.get('electricity', null) ?? DEFAULT_ELECTRICITY,
      defaults: { pricing: DEFAULT_PRICING, subscription: DEFAULT_SUBSCRIPTION, electricity: DEFAULT_ELECTRICITY },
    });
  });

  // Persist any subset of { subscription, electricity, pricing }. Numbers are
  // validated; pricing entries are sanitized to { input, output } per model.
  app.put('/api/settings/cost', (req, res) => {
    const body = req.body || {};
    const nn = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0; // non-negative finite
    const pos = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0; // positive finite
    if (body.subscription) {
      const s = body.subscription;
      if (!nn(s.planPriceUsd) || !pos(s.allowanceTokens)) {
        return res.status(400).json({ error: 'subscription needs a non-negative planPriceUsd and a positive allowanceTokens' });
      }
      const period = ['week', 'month', 'year'].includes(s.period) ? s.period : 'month';
      appConfig.set('subscription', { planPriceUsd: s.planPriceUsd, allowanceTokens: s.allowanceTokens, period });
    }
    if (body.electricity) {
      const e = body.electricity;
      if (!nn(e.powerWatts) || !pos(e.tokensPerSec) || !nn(e.pricePerKwh)) {
        return res.status(400).json({ error: 'electricity needs non-negative powerWatts and pricePerKwh and a positive tokensPerSec' });
      }
      appConfig.set('electricity', { powerWatts: e.powerWatts, tokensPerSec: e.tokensPerSec, pricePerKwh: e.pricePerKwh });
    }
    if (body.pricing && typeof body.pricing === 'object' && !Array.isArray(body.pricing)) {
      const clean = {};
      for (const [k, v] of Object.entries(body.pricing)) {
        if (v && nn(v.input) && nn(v.output)) clean[k] = { input: v.input, output: v.output };
      }
      appConfig.set('pricing', clean);
    }
    res.json({ ok: true });
  });

  // Post-session quality 1-tap (USEFUL | PARTIAL | MISLEADING) — the only
  // honest watch on silent deliberation regression from severity-collapse.
  app.post('/api/sessions/:id/quality', (req, res) => {
    const id = req.params.id;
    const rating = (req.body && req.body.rating) || '';
    if (!['USEFUL', 'PARTIAL', 'MISLEADING'].includes(rating)) {
      return res.status(400).json({ error: 'rating must be USEFUL, PARTIAL, or MISLEADING' });
    }
    if (!stmts.getSession.get(id)) return res.status(404).json({ error: 'Session not found' });
    stmts.updateSessionSynthesisQuality.run(rating, Date.now(), id);
    res.json({ ok: true, rating });
  });

  app.post('/api/sessions', validateBody(httpCreateSessionBody), async (req, res) => {
    const { problem, file_ids, preset_id, continuesFromSessionId } = req.body;
    try {
      const session = await createSession(problem, file_ids || [], preset_id || null, continuesFromSessionId || null);
      broadcast(session.id, { type: 'session-created', session: { id: session.id, problem: session.problem, phase: session.phase, active: session.active, createdAt: session.createdAt } });
      runDeliberation(session).catch(err => req.log.error({ sessionId: session.id, err: err.message }, 'deliberation error'));
      res.json({ id: session.id, problem: session.problem, phase: session.phase, active: true, createdAt: session.createdAt });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/resume', validateBody(httpResumeSessionBody), (req, res) => {
    const id = req.params.id;
    const { session, resumePhase, error, status } = resumeSession(
      { stmts, AGENTS, PHASES, activeSessions, loadSession, runDeliberation, specialist, getAgentsForSession, broadcast, broadcastGlobal, log: req.log },
      id,
    );
    if (error) return res.status(status).json({ error });
    // Push the new active=1 state to every connected client so list filters
    // (Active/Done) reflect the resumed state without a manual refresh.
    try {
      const row = stmts.getRecentSessions.all().find(r => r.id === session.id);
      if (row) broadcastGlobal({ type: 'session-updated', session: enrichSession(row, stmts) });
    } catch (_) {}
    res.json({ ok: true, sessionId: session.id, resumedFromPhase: resumePhase });
  });

  // ─── Semantic Search (MUST be before /api/sessions/:id — SCAR S1) ──
  app.get('/api/sessions/search/semantic', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 20);
    try {
      const vec = await embed(q);
      if (!vec) return res.json([]); // Ollama down — graceful fallback (SCAR S15)
      // The vec0 MATCH query stays inline — better-sqlite3 prepared cache
      // does not always like the bound vector parameter on a virtual table,
      // and this is the one route the spec calls out as the legitimate
      // exception to F17.
      const rows = db.prepare('SELECT rowid, distance FROM session_embeddings WHERE embedding MATCH ? AND k = ?').all(vec, limit * 2);
      if (!rows.length) return res.json([]);
      // Map rowids to session_ids via embedding_meta, dedup by session_id
      const seen = new Map();
      for (const row of rows) {
        const meta = stmts.getEmbeddingMetaByRowid.get(row.rowid);
        if (meta && !seen.has(meta.session_id)) {
          // Convert L2 distance to 0-1 similarity: 1 / (1 + distance)
          seen.set(meta.session_id, 1 / (1 + row.distance));
        }
      }
      const results = [];
      for (const [sessionId, similarity] of seen) {
        const s = stmts.getSession.get(sessionId);
        if (s) results.push({ ...enrichSession(s, stmts), similarity });
        if (results.length >= limit) break;
      }
      results.sort((a, b) => b.similarity - a.similarity);
      res.json(results);
    } catch (err) {
      req.log.error({ err: err.message }, 'semantic search error');
      res.json([]);
    }
  });

  // ─── Pin ───────────────────────────────────────────────────
  app.put('/api/sessions/:id/pin', validateBody(httpPinBody), (req, res) => {
    const s = stmts.getSession.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    const pinned = req.body.pinned ? 1 : 0;
    stmts.toggleSessionPin.run(pinned, Date.now(), req.params.id);
    res.json({ ok: true, pinned: !!pinned });
  });

  // ─── Mid-session file attachment ─────────────────────────────
  app.post('/api/sessions/:id/files', validateBody(httpAttachFilesBody), async (req, res) => {
    const session = stmts.getSession.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    try {
      const files = await attachFiles(req.params.id, req.body.file_ids);
      // If session is in-memory (active), mark it as having files
      const active = activeSessions.get(req.params.id);
      if (active) active._hasFiles = true;
      res.json({ ok: true, files });
    } catch (err) {
      const status = err.status || 500;
      res.status(status).json({ error: err.message });
    }
  });

  app.get('/api/search', (req, res) => {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const sessions = stmts.searchSessions.all(like, like);
    res.json(sessions.map(s => ({
      id: s.id, problem: s.problem, phase: s.phase,
      active: !!s.active, createdAt: s.created_at,
      messageCount: stmts.messageCountForSession.get(s.id).c
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
      req.log.error({ err: err.message }, 'memory search error');
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
    if (format === 'json') return buildJsonExport(session, mode, createdAt, finishedAt, PHASES.length);
    return buildTextExport(session, mode, format, createdAt, finishedAt);
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
    if (!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z0-9]{6,32})$/i.test(id)) return res.status(400).json({ error: 'Invalid session id' });
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
      req.log.error({ sessionId: id, err: err.message }, 'export error');
      return res.status(500).json({ error: 'Export failed', detail: err.message });
    }
  });

  app.get('/api/sessions/:id/export/options', (req, res) => {
    const { id } = req.params;
    if (!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z0-9]{6,32})$/i.test(id)) return res.status(400).json({ error: 'Invalid session id' });
    const sessionRow = stmts.getSession.get(id);
    if (!sessionRow) return res.status(404).json({ error: 'Session not found' });
    const messageCount = stmts.messageCountForSession.get(id).c;
    const synthesisCount = stmts.synthCountForSession.get(id).c;
    const qaCount = stmts.escalationCountForSession.get(id).c;
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

  // HLB-794 — verbatim Decision Record: the Synthesis-phase verdict as JSON, so
  // a caller can lift the verdict out of a completed session without the full
  // transcript and without an extra LLM call. Returns available:false for a
  // failed or synthesis-less session.
  app.get('/api/sessions/:id/decision-record', (req, res) => {
    const { id } = req.params;
    if (!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-z0-9]{6,32})$/i.test(id)) return res.status(400).json({ error: 'Invalid session id' });
    const record = buildDecisionRecord(stmts, id);
    if (!record) return res.status(404).json({ error: 'Session not found' });
    res.json(record);
  });
}

module.exports = { setupRoutes, enrichSession };
