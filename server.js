const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const crypto = require('crypto');

// ─── Modules ────────────────────────────────────────────────
const { db, stmts, dbPath } = require('./db');
const appConfig = require('./lib/app-config');
appConfig.init(stmts); // HLB-336 — load runtime routing/pricing settings into the cache at boot
const { AGENTS, getAgentsForSession } = require('./lib/agents');
const { PHASES, createRouter } = require('./lib/phases');
const { callAnthropic, callAnthropicWithTools, callLLMRaw, resolveRoute, defaultRouteBilling, anyLLMInFlight, inFlightLLMCount, AGENT_MAX_TOKENS, parseAgentMaxTokens } = require('./lib/llm');
const { runWithTools } = require('./lib/agents/tool-loop');
const { WEB_SEARCH_TOOL, formatToolResult } = require('./lib/tools/web-search');
const { setupRoutes } = require('./lib/routes');
const { setupWebSocket } = require('./lib/ws-handler');
const { requireAuthWS } = require('./lib/auth');
const { setupMCPServer } = require('./mcp/http');
const { createMemoryManager } = require('./lib/memory');
const { createQualityManager } = require('./lib/quality');
const { createFingerprintClassifier } = require('./lib/fingerprint');
const { createSpecialistSpawner } = require('./lib/specialist');
const { getPreset, listPresets } = require('./lib/presets');
const { deliberationOutcome } = require('./lib/outcome');
const { createTokenLedger, persistSessionTokens, createTickThrottle } = require('./lib/token-usage');
const { costFromSnapshot, billingForRoute, amortizedPerToken, electricityPerToken } = require('./lib/cost');
const { repriceLegacySessions } = require('./lib/cost-backfill');
const { estimateTokens } = require('./lib/embeddings');
const { buildContext } = require('./lib/context');
const { createContentBlockBuilder } = require('./lib/prompt/content-blocks');
const { createFilesServiceClient } = require('./lib/clients/files-service');
const { runLegacyFileMigration } = require('./lib/migrate-files');
const jobs = require('./lib/jobs');
const { log, withSession } = require('./lib/logger');
const { waitForEscalation, abortSessionWaits, getDeadline, pauseEscalation, defaultAnswerFor, DEFAULT_TIMEOUT_MS } = require('./lib/escalation');
const { createSearchProvider } = require('./lib/search');
const { getSearchConfigForAgent, makeSessionBudget, SESSION_QUERY_BUDGET, AGENT_SEARCH_EXPANSION } = require('./lib/agents/search-config');
const { createMetricsSink, tierForAgent } = require('./lib/metrics/search-metrics');

// F10 — process-level error handlers. Installed immediately after imports
// and BEFORE any other setup so a throw during boot still gets logged.
// unhandledRejection: log and stay alive (the job worker and flaky LLM
// calls should not be allowed to take the server down).
// uncaughtException: log fatal, attempt graceful shutdown.
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason && reason.stack || reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err) => {
  log.fatal({ err: err && err.stack || err }, 'uncaughtException');
  try { shutdown(); } catch (_) { process.exit(1); }
});

const PORT = process.env.PORT || 8090;

// ─── LLM config logging ────────────────────────────────────
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.MODEL || 'anthropic/claude-opus-4-8';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
const SEARCH_MAX_RESULTS = parseInt(process.env.SEARCH_MAX_RESULTS || '5');
const SEARCH_PROVIDER = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://host.docker.internal:9090';
const SCOUT_USE_TOOL = String(process.env.SCOUT_USE_TOOL || '').toLowerCase() === 'true';

if (OPENAI_API_KEY) {
  log.info({ baseUrl: OPENAI_BASE_URL }, 'LLM backend: OpenAI-compatible API');
} else if (ANTHROPIC_API_KEY) {
  log.info({ keyPrefix: ANTHROPIC_API_KEY.slice(0, 12) }, 'LLM: Direct Anthropic API');
} else {
  log.warn('No LLM config: set OPENAI_API_KEY (and optional OPENAI_BASE_URL) or ANTHROPIC_API_KEY');
}

log.info({
  provider: SEARCH_PROVIDER,
  searxngUrl: SEARXNG_URL,
  tavilyConfigured: !!TAVILY_API_KEY,
  scoutUseTool: SCOUT_USE_TOOL,
  agentSearchExpansion: AGENT_SEARCH_EXPANSION,
  sessionQueryBudget: SESSION_QUERY_BUDGET,
}, 'Search provider configured');
if (SEARCH_PROVIDER === 'tavily' && !TAVILY_API_KEY) {
  log.warn('SEARCH_PROVIDER=tavily but TAVILY_API_KEY unset — Research Scout will operate without live search');
}
if (SEARCH_PROVIDER === 'coexist' && !TAVILY_API_KEY) {
  log.warn('SEARCH_PROVIDER=coexist but TAVILY_API_KEY unset — fallback path will return errors');
}

// ─── Express + WebSocket ────────────────────────────────────
const app = express();
const server = http.createServer(app);
// noServer mode lets us auth-gate the upgrade handshake (F1 / S01).
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!requireAuthWS(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// ─── Files-Service Client ───────────────────────────────────
const FILES_SERVICE_URL = process.env.FILES_SERVICE_URL || null;
const FILES_SERVICE_TOKEN = process.env.FILES_SERVICE_TOKEN || null;
const FILE_TOKEN_BUDGET = parseInt(process.env.FILE_TOKEN_BUDGET || '150000', 10);

let filesServiceClient = null;
let contentBlockBuilder = null;

if (FILES_SERVICE_URL && FILES_SERVICE_TOKEN) {
  filesServiceClient = createFilesServiceClient({ url: FILES_SERVICE_URL, token: FILES_SERVICE_TOKEN });
  contentBlockBuilder = createContentBlockBuilder({
    db,
    filesServiceClient,
    config: { fileTokenBudget: FILE_TOKEN_BUDGET, filesServiceUrl: FILES_SERVICE_URL, filesServiceToken: FILES_SERVICE_TOKEN },
  });
  log.info({ url: FILES_SERVICE_URL }, 'files-service client configured');
} else {
  log.warn('No FILES_SERVICE_URL/TOKEN — file attachment features disabled');
}

// ─── Shared State ───────────────────────────────────────────
const activeSessions = new Map();

// HLB-152 — per-session token ledger. Every LLM/embedding call routed through a
// session-aware caller adds its normalized usage here; the deliberation-
// complete path snapshots and persists it to the sessions row. onTokenUsage is
// the seam the memory/quality/fingerprint managers use to attribute the usage
// of the callAnthropic calls they own.
const tokenLedger = createTokenLedger();
// HLB-335 — live "on the fly" token counter. Every accrual can push a snapshot
// to the session's subscribers, throttled to one broadcast per TOKEN_TICK_MS so
// a busy phase does not spam the socket (UI no-flicker rule: render <= 1/1-2s).
// The authoritative tokens-counted still fires at each completion boundary, so a
// dropped intermediate tick never loses the final number.
const TOKEN_TICK_MS = 1500;
const tokenTick = createTickThrottle(TOKEN_TICK_MS);
function onTokenUsage(sessionId, category, usage, opts) {
  try {
    tokenLedger.add(sessionId, category, usage, opts);
    if (sessionId && tokenTick.shouldEmit(sessionId, Date.now())) {
      broadcast(sessionId, { type: 'token-tick', sessionId, ...tokenCostSnapshot(sessionId) });
    }
  }
  catch (err) { log.warn({ sessionId, err: err && err.message }, 'token ledger add failed'); }
}

// HLB-337 — pricing / subscription / electricity config from the settings
// store; cost.js applies sensible defaults for anything unset.
//
// routeBilling says how each route is PAID. cost.js cannot infer that for the
// deployment's own endpoint, so llm.js answers it here and an operator override
// wins over both. Without this the default route was billed at metered rates on
// a deployment that pays a flat subscription.
function costConfig() {
  return {
    pricing: appConfig.get('pricing', null),
    subscription: appConfig.get('subscription', null),
    electricity: appConfig.get('electricity', null),
    routeBilling: { default: defaultRouteBilling(), ...appConfig.get('route_billing', {}) },
  };
}

// Cost for a session's current tally. Agent turns and tool calls are attributed
// to their actual per-agent route+model (the ledger's by_model); everything
// else (quality, memory, embeddings, meta) is folded into the session's default
// route+model so the dollar total covers every counted token.
function costForSnapshot(snap) {
  const def = resolveRoute(undefined);
  const key = `${def.route || 'default'}::${def.model}`;
  return costFromSnapshot(snap, key, costConfig());
}

// The token + cost payload broadcast on token-tick / tokens-counted and written
// to the session row at completion.
function tokenCostSnapshot(sessionId) {
  const snap = tokenLedger.snapshot(sessionId);
  const cost = costForSnapshot(snap);
  return {
    totalTokens: snap.total_tokens,
    breakdown: snap.token_breakdown,
    totalCostUsd: cost.total_cost_usd,
    costBreakdown: cost.cost_breakdown,
    costModes: cost.modes,
  };
}

const memory = createMemoryManager({ db, stmts, callAnthropic, AGENTS, PHASES, onTokenUsage });
const quality = createQualityManager({ db, stmts, callAnthropic, PHASES, onTokenUsage });
const fingerprint = createFingerprintClassifier({ callAnthropic, db, stmts, onTokenUsage });
const specialist = createSpecialistSpawner({ db, stmts });

function genId() { return crypto.randomUUID(); }

// F2 — per-session subscription. broadcast(sessionId, data) only delivers to
// clients that have subscribed to that session via {type:'subscribe',sessionId}
// or auto-subscribed via join-session / new-session. broadcastGlobal is the
// explicit opt-in for messages every client should see (e.g. agent-list refresh).
function broadcast(sessionId, data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.subscribedSessions && client.subscribedSessions.has(sessionId)) {
      client.send(msg);
    }
  });
}

function broadcastGlobal(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

// ─── Session Management ─────────────────────────────────────

/**
 * Denormalize file metadata from files-service into session_files.
 * Returns array of denormalized file objects. Throws on any file_id not found.
 */
async function attachFiles(sessionId, fileIds) {
  if (!fileIds || fileIds.length === 0) return [];
  if (!filesServiceClient) throw new Error('files-service not configured');
  const now = Date.now();
  const attached = [];
  for (const fileId of fileIds) {
    const meta = await filesServiceClient.getFile(fileId);
    if (!meta) throw Object.assign(new Error(`file_id ${fileId} not found`), { status: 400 });
    stmts.insertFile.run(sessionId, meta.id, meta.sha256, meta.name, meta.tokens, meta.mime, now);
    attached.push({ file_id: meta.id, file_sha256: meta.sha256, file_name: meta.name, file_tokens: meta.tokens, file_mime: meta.mime });
  }
  return attached;
}

async function createSession(problem, fileIds = [], presetId = null, continuesFromSessionId = null) {
  const id = genId();
  const now = Date.now();
  stmts.insertSession.run(id, problem, now, now);

  const preset = getPreset(presetId);
  if (preset) stmts.updateSessionPreset.run(preset.id, now, id);

  if (continuesFromSessionId) stmts.updateSessionContinuation.run(continuesFromSessionId, now, id);

  let files = [];
  if (fileIds.length > 0) {
    files = await attachFiles(id, fileIds);
  }

  const session = {
    id, problem, phase: 0,
    messages: [], humanMessages: [], escalations: [],
    agentStates: {}, active: true, createdAt: now,
    _hasFiles: files.length > 0,
    _preset: preset,
    presetId: preset ? preset.id : null,
    continuesFromSessionId: continuesFromSessionId || null,
    searchCache: new Map(),
    searchBudget: makeSessionBudget(),
  };
  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  activeSessions.set(id, session);

  // Generate shadow (adversarial twin) answer async, non-blocking
  quality.generateShadowAnswer(id, problem).catch(err =>
    log.warn({ sessionId: id, err: err.message }, 'shadow generation error')
  );

  return session;
}

// HLB-148: the per-escalation countdown the client renders. A live blocking
// wait owns a mutable deadline (pause/reset/resume mutate it); getDeadline()
// reads it. When no live waiter exists, the deadline is only meaningful if the
// session is still ACTIVE (its escalation will get a waiter once the phase gate
// opens). For an INACTIVE session there is nothing left to auto-resolve, so we
// return deadlineAt:null instead of fabricating a past `created_at + window`
// timestamp that would render a false 0:00. Answered escalations carry no
// countdown.
//   esc: { id, sessionId, answered, createdAt }
//   isActive: whether the owning session is active (live deliberation)
// Returns { deadlineAt, paused } merged onto the escalation object.
function escalationTiming(esc, isActive = false) {
  if (esc.answered) return { deadlineAt: null, paused: false };
  const live = getDeadline(esc.sessionId, esc.id);
  if (live) return { deadlineAt: live.deadlineAt, paused: live.paused };
  // No live waiter. Honor any pause/reset/resume the human already applied
  // (mirrored onto the in-memory escalation by the escalation-timer handler),
  // that is a deliberate human action regardless of active state.
  if (esc.paused === true && typeof esc.deadlineAt === 'number') {
    return { deadlineAt: esc.deadlineAt, paused: true };
  }
  if (typeof esc.deadlineAt === 'number') {
    return { deadlineAt: esc.deadlineAt, paused: false };
  }
  // No waiter, no human-applied deadline. Only an ACTIVE session's escalation
  // (created before its phase gate) will acquire a waiter and auto-resolve, so
  // give it a fallback window. An inactive escalation will never auto-resolve,
  // render a neutral state, no ticking countdown.
  if (!isActive) return { deadlineAt: null, paused: false };
  const base = (typeof esc.createdAt === 'number' ? esc.createdAt : Date.now());
  return { deadlineAt: base + DEFAULT_TIMEOUT_MS, paused: false };
}

function loadSession(id) {
  const row = stmts.getSession.get(id);
  if (!row) return null;
  const messages = stmts.getSessionMessages.all(id).map(m => ({
    id: m.id, agentId: m.agent_id, agentName: m.agent_name,
    agentEmoji: m.agent_emoji, agentColor: m.agent_color,
    content: m.content, phase: m.phase, timestamp: m.created_at
  }));
  const escalations = stmts.getSessionEscalations.all(id).map(e => {
    const esc = {
      id: e.id, agentId: e.agent_id, agentName: e.agent_name, agentEmoji: e.agent_emoji,
      question: e.question, sessionId: id, answered: e.status === 'answered',
      answer: e.answer, createdAt: e.created_at,
      severity: e.severity || 'blocking', defaultAction: e.default_action || null,
    };
    return { ...esc, ...escalationTiming(esc, !!row.active) };
  });
  const humanMessages = stmts.getSessionHumanMessages.all(id).map(h => ({
    id: h.id, content: h.content, timestamp: h.created_at
  }));
  const files = stmts.getSessionFiles.all(id).map(f => ({
    file_id: f.file_id, file_name: f.file_name, file_tokens: f.file_tokens,
    file_mime: f.file_mime, file_sha256: f.file_sha256,
  }));
  let specialistAgents = [];
  if (row.specialist_agents) {
    try { specialistAgents = JSON.parse(row.specialist_agents) || []; } catch (_) {}
  }
  return {
    id: row.id, problem: row.problem, phase: row.phase,
    active: !!row.active, messages, escalations, humanMessages,
    files, agentStates: {}, createdAt: row.created_at, updatedAt: row.updated_at,
    archetypeId: row.archetype_id || null,
    qualityScore: row.quality_score ?? null,
    pinned: !!row.pinned,
    specialistAgents,
    _hasFiles: files.length > 0,
    _preset: getPreset(row.preset_id),
    presetId: row.preset_id || null,
    continuesFromSessionId: row.continues_from_session_id || null,
    totalTokens: row.total_tokens ?? null,
    tokenBreakdown: (() => { try { return row.token_breakdown ? JSON.parse(row.token_breakdown) : null; } catch (_) { return null; } })(),
    // How the run ended, for every reader of GET /api/sessions/:id — the web
    // UI and the stdio MCP transport included. Without it those surfaces can
    // only see `active`, which is exactly the blindness that let a session
    // stopped at Problem Framing read as a completed one.
    outcome: row.outcome ?? null,
    crashRecoveredAt: row.crash_recovered_at ?? null,
    totalPhases: PHASES.length,
  };
}

// ─── Search Provider ────────────────────────────────────────
// Instantiated once at startup. Per-session dedup cache is stored on the
// session object (`session.searchCache`) and GC'd when the session object
// is dropped from activeSessions.
const searchProvider = createSearchProvider({
  provider: SEARCH_PROVIDER,
  tavilyApiKey: TAVILY_API_KEY,
  searxngUrl: SEARXNG_URL,
  maxResults: SEARCH_MAX_RESULTS,
  logger: log,
  broadcast,
});

// ─── Metrics Sink (S6 canary) ───────────────────────────────
// One sink per server process. Writes to search_metrics via synchronous
// prepared statement. Sink errors are swallowed by the tool-loop wrapper
// so a metrics write failure cannot fail a deliberation.
const metricsSink = createMetricsSink(db);

// Escalation is delivered as a structured tool call — see ESCALATE_TOOL below.
// This regex path is kept as a belt-and-suspenders fallback so a prompt slip
// (prose XML tag, legacy flat marker) still surfaces a question instead of
// silently dropping it.
function extractEscalations(text, agentId, sessionId) {
  const escalations = [];
  const xmlRegex = /<need_human_input>\s*([\s\S]+?)\s*<\/need_human_input>/gi;
  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    const q = match[1].trim();
    if (q) escalations.push({ id: genId(), agentId, question: q, severity: 'blocking', defaultAction: null, sessionId, answered: false, answer: null, createdAt: Date.now() });
  }
  const legacy = /NEED_HUMAN_INPUT:\s*(.+?)(?:\n|$)/g;
  while ((match = legacy.exec(text)) !== null) {
    const q = match[1].trim();
    if (q) escalations.push({ id: genId(), agentId, question: q, severity: 'blocking', defaultAction: null, sessionId, answered: false, answer: null, createdAt: Date.now() });
  }
  return escalations;
}

const ESCALATE_TOOL = {
  name: 'escalate_to_human',
  description: 'Send ONE forced-choice question to the human facilitator. Use ONLY for an ambiguity that changes scope, success criteria, or the final recommendation and that only the human can resolve — not for rhetorical questions that belong in your deliberation output. If you cannot name two genuinely competing options, do not call this — decide and announce it in your response instead.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'A single forced-choice question, phrased: "QUESTION — [A] <option> / [B] <option> — default: A". Directly answerable, not a topic or a list.',
      },
      severity: {
        type: 'string',
        enum: ['blocking', 'optional'],
        description: '"blocking" if the deliberation cannot sensibly continue without the answer; "optional" if you have a safe default and only want confirmation. Optional questions are auto-resolved to default_action if unanswered.',
      },
      default_action: {
        type: 'string',
        description: 'In one clause, exactly what you will assume if the human does not answer (your option A).',
      },
    },
    required: ['question', 'severity'],
  },
};

function escalationsFromToolCalls(toolCalls, agentId, sessionId) {
  return (toolCalls || [])
    .filter(tc => tc.name === 'escalate_to_human' && tc.input && typeof tc.input.question === 'string' && tc.input.question.trim())
    .map(tc => ({
      id: genId(),
      agentId,
      question: tc.input.question.trim(),
      // Default to 'blocking' on an unrecognized/missing value so an
      // un-classified escalation is never silently auto-skipped.
      severity: tc.input.severity === 'optional' ? 'optional' : 'blocking',
      defaultAction: (typeof tc.input.default_action === 'string' && tc.input.default_action.trim())
        ? tc.input.default_action.trim() : null,
      sessionId,
      answered: false,
      answer: null,
      createdAt: Date.now(),
    }));
}

// ─── Context Building ───────────────────────────────────────
// buildContext lives in lib/context.js (F6) — extracted so the trim loop is
// testable in isolation and so the static header/footer survive every trim.

// ─── Agent Turn ─────────────────────────────────────────────
async function runAgentTurn(session, agentId, phase) {
  const sessionAgents = getAgentsForSession(session);
  const agent = sessionAgents.find(a => a.id === agentId);
  const isResearchScout = agentId === 'research-scout';
  const sLog = withSession(session.id);
  session.agentStates[agentId] = 'thinking';
  broadcast(session.id, { type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });

  const turnT0 = Date.now();
  const agentTier = tierForAgent(agentId);
  let turnPath = 'none';
  let turnRoundsUsed = null;
  let turnQueriesEmitted = null;
  let turnQueriesExecuted = null;
  let turnTruncated = null;
  let turnBudgetExhausted = null;
  let turnError = null;
  let response = '';

  try {
    let messages = buildContext(session, agentId, phase);

    // If files are attached and content block builder is available,
    // replace the plain text user content with content block array
    // (file blocks + original context text as final block).
    if (contentBlockBuilder && session._hasFiles) {
      const contextText = messages[0].content;
      const contentBlocks = await contentBlockBuilder.buildContentBlocks(session, {
        query: `${agent.role || agent.name}\n${PHASES[phase].name}\n${session.problem}`,
        contextText,
      });
      messages = [{ role: 'user', content: contentBlocks }];
    }

    const isFinalSynthesis = (phase === PHASES.length - 1) && (agentId === 'process-architect');
    // Synthesis is the longest turn in the room, so it is the last place that
    // wants a ceiling. Uncapped unless a deployment sets SYNTHESIS_MAX_TOKENS.
    const maxTokens = isFinalSynthesis ? parseAgentMaxTokens(process.env.SYNTHESIS_MAX_TOKENS) : AGENT_MAX_TOKENS;

    const searchAvailable = SEARCH_PROVIDER === 'smart'
      || SEARCH_PROVIDER === 'coexist'
      || !!TAVILY_API_KEY;

    const searchConfig = getSearchConfigForAgent(agentId);
    const useToolLoop = !!searchConfig && searchAvailable;

    let toolCalls;

    if (useToolLoop) {
      turnPath = 'tool_use';
      // Unified tool_use path. Scout and any other tier-enabled agent drive
      // search via the web_search tool inside a bounded tool-loop.
      // Escalations piggy-back on the same loop via escalate_to_human
      // (handled post-turn from toolInvocations).
      if (!session.searchCache) session.searchCache = new Map();
      if (!session.searchBudget) session.searchBudget = makeSessionBudget();

      const webSearchHandler = async (input) => {
        if (!searchAvailable) return 'Web search is not configured for this session.';
        const qs = Array.isArray(input.queries) ? input.queries.filter(q => typeof q === 'string' && q.trim()) : [];
        if (qs.length === 0) return 'No queries provided.';
        session.agentStates[agentId] = 'searching';
        broadcast(session.id, { type: 'agent-state', agentId, state: 'searching', sessionId: session.id });
        broadcast(session.id, { type: 'search-started', agentId, queries: qs, sessionId: session.id });
        const results = await searchProvider.search(qs, session.searchCache, { sessionId: session.id, agentId });
        session.agentStates[agentId] = 'thinking';
        broadcast(session.id, { type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });
        return formatToolResult(results);
      };
      const escalateHandler = async (input) => {
        const q = input && typeof input.question === 'string' ? input.question.trim() : '';
        return q ? 'Escalation queued for the human facilitator.' : 'Escalation requires a question string.';
      };

      const loopOut = await runWithTools({
        llmCall: callLLMRaw,
        // No explicit model: an explicit one outranks the agent's configured
        // model in resolveRoute, which would ship the global default model to
        // whatever provider the agent is routed to. The prose path resolves
        // from agentId alone; this path must match it.
        model: undefined,
        system: agent.systemPrompt,
        messages,
        tools: [WEB_SEARCH_TOOL, ESCALATE_TOOL],
        toolHandlers: { web_search: webSearchHandler, escalate_to_human: escalateHandler },
        maxRounds: searchConfig.maxRounds,
        maxQueriesPerCall: searchConfig.maxQueries,
        sessionBudget: session.searchBudget,
        maxTokens,
        broadcast,
        sessionId: session.id,
        agentId,
        logger: sLog,
        metricsSink,
        agentTier,
        provider: SEARCH_PROVIDER,
      });

      const finalBlocks = (loopOut.finalMessage && loopOut.finalMessage.content) || [];
      response = finalBlocks.filter(b => b && b.type === 'text').map(b => b.text).join('');
      toolCalls = loopOut.toolInvocations
        .filter(inv => inv.toolName === 'escalate_to_human')
        .map(inv => ({ name: 'escalate_to_human', input: inv.input || {} }));

      // Usage from the tool-loop is the sum across every round-trip in this
      // turn. Attribute it to the tool-call bucket since this is the search-
      // enabled path.
      onTokenUsage(session.id, 'tool_call', loopOut.usage, { model: loopOut.model, route: loopOut.route });

      // Aggregate per-invocation search numbers for the turn-complete row.
      // Truncation is a property of any individual invocation, so truncated
      // at the turn level is "any call was truncated".
      const searchInvs = loopOut.toolInvocations.filter(inv => inv.toolName === 'web_search');
      if (searchInvs.length > 0) {
        turnQueriesEmitted = searchInvs.reduce((n, inv) => {
          const qs = inv && inv.input && Array.isArray(inv.input.queries) ? inv.input.queries.length : 0;
          return n + qs;
        }, 0);
        turnQueriesExecuted = searchInvs.reduce((n, inv) => {
          if (inv.skippedByBudget) return n;
          const qs = inv && inv.input && Array.isArray(inv.input.queries) ? inv.input.queries.length : 0;
          return n + qs;
        }, 0);
      }
      turnRoundsUsed = loopOut.rounds;
      turnBudgetExhausted = !!loopOut.budgetExhausted;
    } else {
      // Prose-marker path (pre-Session-4 default; stays canonical until canary flips SCOUT_USE_TOOL).
      let primary;
      ({ text: response, toolCalls, ...primary } = await callAnthropicWithTools(agent.systemPrompt, messages, agentId, [ESCALATE_TOOL], maxTokens));
      onTokenUsage(session.id, 'agent_turn', primary.usage, { model: primary.model, route: primary.route });

      if (isResearchScout && searchAvailable) {
        const searchQueries = searchProvider.extractQueriesFromText(response);
        turnPath = 'prose_marker';
        turnQueriesEmitted = searchQueries.length;
        if (searchQueries.length > 0) {
          session.agentStates[agentId] = 'searching';
          broadcast(session.id, { type: 'agent-state', agentId, state: 'searching', sessionId: session.id });
          broadcast(session.id, { type: 'search-started', agentId, queries: searchQueries, sessionId: session.id });
          sLog.info({ queries: searchQueries }, 'research scout searching');
          if (!session.searchCache) session.searchCache = new Map();
          const searchResults = await searchProvider.search(searchQueries, session.searchCache, { sessionId: session.id, agentId });
          const resultsText = searchProvider.formatSearchResults(searchResults);
          turnQueriesExecuted = searchResults.length;
          session.agentStates[agentId] = 'thinking';
          broadcast(session.id, { type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });
          const synthesisMessages = [
            ...messages,
            { role: 'assistant', content: response },
            { role: 'user', content: `Your search queries have been executed. Here are the results:${resultsText}\n\nNow synthesize these findings into a comprehensive research brief for the team. Include:\n1. Key findings from the search results\n2. Source quality assessment\n3. How this information relates to the problem\n4. Remaining knowledge gaps\n\nDo NOT include any SEARCH: markers in this response.` },
          ];
          const follow = await callAnthropicWithTools(agent.systemPrompt, synthesisMessages, agentId, [ESCALATE_TOOL]);
          response = follow.text;
          toolCalls = [...toolCalls, ...follow.toolCalls];
          onTokenUsage(session.id, 'agent_turn', follow.usage, { model: follow.model, route: follow.route });
        } else {
          turnQueriesExecuted = 0;
        }
      }
    }

    session.agentStates[agentId] = 'speaking';
    broadcast(session.id, { type: 'agent-state', agentId, state: 'speaking', sessionId: session.id });
    const now = Date.now();
    const msgId = genId();
    const msg = { id: msgId, agentId, agentName: agent.name, agentEmoji: agent.emoji, agentColor: agent.color, content: response, phase: PHASES[phase].name, timestamp: now };
    session.messages.push(msg);
    stmts.insertMessage.run(msgId, session.id, agentId, agent.name, agent.emoji, agent.color, response, PHASES[phase].name, now);
    broadcast(session.id, { type: 'message', ...msg, sessionId: session.id });

    const toolEscalations = escalationsFromToolCalls(toolCalls, agentId, session.id);
    const regexEscalations = extractEscalations(response, agentId, session.id);
    const seen = new Set(toolEscalations.map(e => e.question));
    const escalations = [...toolEscalations, ...regexEscalations.filter(e => !seen.has(e.question))];
    escalations.forEach(esc => {
      session.escalations.push(esc);
      stmts.insertEscalation.run(esc.id, session.id, agentId, agent.name, agent.emoji, esc.question, esc.severity, esc.defaultAction, esc.createdAt);
      // HLB-148: send the countdown deadline with the escalation so the inline
      // card and queue can render time-remaining from the first frame. The
      // blocking wait that owns the live deadline starts at the next phase
      // gate; until then the client shows the created_at + default window.
      broadcast(session.id, { type: 'escalation', ...esc, ...escalationTiming(esc, session.active !== false), agentName: agent.name, agentEmoji: agent.emoji });
    });

    session.agentStates[agentId] = 'idle';
    broadcast(session.id, { type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    turnError = err && err.message ? err.message : String(err);
    sLog.error({ agentId, err: turnError }, 'agent turn error');
    session.agentStates[agentId] = 'idle';
    broadcast(session.id, { type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    broadcast(session.id, { type: 'error', agentId, message: `${agent.name} encountered an error: ${turnError}`, sessionId: session.id });
  } finally {
    // Always emit an agent_turn_complete row — even for Tier D turns
    // (path='none') and error turns. Denominator accuracy matters for the
    // canary's tool_use_emission_rate.
    try {
      metricsSink.record({
        sessionId: session.id,
        agentId,
        agentTier,
        path: turnPath,
        eventType: 'agent_turn_complete',
        roundsUsed: turnRoundsUsed,
        queriesEmitted: turnQueriesEmitted,
        queriesExecuted: turnQueriesExecuted,
        truncated: null,
        budgetExhaustedTerminal: turnBudgetExhausted,
        synthesisChars: response ? response.length : 0,
        latencyMs: Date.now() - turnT0,
        error: turnError,
        provider: turnPath === 'none' ? null : SEARCH_PROVIDER,
      });
    } catch (err) {
      sLog.error({ agentId, err: err && err.message }, 'metrics sink threw on agent_turn_complete');
    }
  }
  // The loop reads this to spot a provider that is refusing every turn.
  return turnError;
}

// ─── Deliberation Loop ─────────────────────────────────────
// How many agent turns may fail back to back before the run is abandoned. Four
// is one full phase of failures plus one: enough to ride out a single flaky
// agent, short enough that a dead provider costs one phase, not five.
const MAX_CONSECUTIVE_TURN_FAILURES = (() => {
  const n = Number.parseInt(process.env.MAX_CONSECUTIVE_TURN_FAILURES || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 4;
})();

async function runDeliberation(session, resumeFromPhase = 0) {
  const sLog = withSession(session.id);
  // Fingerprint classification + specialist spawning (before Phase 0)
  if (resumeFromPhase > 0) {
    sLog.info({ resumeFromPhase, totalPhases: PHASES.length }, 'resuming deliberation');
  }
  // Specialist domains come from two sources, preset first: the user's role
  // preset (explicit intent) is a stronger signal than the auto-classifier.
  // The classifier still runs for archetype tagging and to top up domains.
  let recommendedSpecialists = [];
  try {
    const classification = await fingerprint.classify(session.problem, { sessionId: session.id });
    if (classification.archetype && classification.confidence >= fingerprint.MIN_CONFIDENCE) {
      sLog.info({
        archetype: classification.archetype,
        confidence: classification.confidence,
        specialists: classification.recommendedSpecialists,
      }, 'fingerprint classified');
      stmts.updateSessionArchetype.run(classification.archetype, Date.now(), session.id);
      const now = Date.now();
      stmts.insertArchetype.run(classification.archetype, classification.archetype, classification.reasoning, now, now);
      stmts.insertSessionArchetype.run(session.id, classification.archetype, classification.confidence);
      recommendedSpecialists = classification.recommendedSpecialists || [];
    } else {
      sLog.info({ confidence: classification.confidence }, 'fingerprint: no confident archetype, proceeding with core 8');
    }
  } catch (err) {
    sLog.warn({ err: err.message }, 'fingerprint classification error (proceeding with core 8)');
  }

  // Preset-seeded specialists take priority, then classifier picks fill the
  // remaining slots (spawnSpecialists caps the total). A preset spawns its
  // specialists even when the classifier is not confident.
  try {
    const presetSpecialists = (session._preset && Array.isArray(session._preset.specialists))
      ? session._preset.specialists : [];
    const domains = [...new Set([...presetSpecialists, ...recommendedSpecialists])];
    if (domains.length > 0) {
      const specialists = specialist.spawnSpecialists(domains);
      if (specialists.length > 0) {
        session._specialists = specialists;
        stmts.updateSessionSpecialists.run(JSON.stringify(specialists.map(s => s.id)), Date.now(), session.id);
        specialists.forEach(s => { session.agentStates[s.id] = 'idle'; });
        const allAgents = getAgentsForSession(session);
        broadcastGlobal({ type: 'agents', agents: allAgents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: !!a.isSpecialist })) });
      }
    }
  } catch (err) {
    sLog.warn({ err: err.message }, 'specialist spawn error (proceeding with core 8)');
  }

  // Seed from a chosen prior session (HLB-147). This block is injected ahead
  // of the similarity-based memory block below so the council reads "where we
  // left off" before "what looks similar". A missing/deleted source is not
  // fatal: the session proceeds as a fresh one.
  if (session.continuesFromSessionId) {
    try {
      const summary = memory.buildSessionSummary(session.continuesFromSessionId);
      const src = stmts.getSession.get(session.continuesFromSessionId);
      if (summary && src) {
        // buildSessionSummary already opens with a (capped) `Problem:` line, so
        // the summary body carries the prior problem; no separate Problem line.
        session._continuationText =
          `=== CONTINUED FROM PRIOR SESSION ===\nSource session: ${src.id}\n\n${summary}\n=== END CONTINUED FROM PRIOR SESSION ===\n\n`;
        broadcast(session.id, { type: 'continuation-injected', sessionId: session.id, sourceId: src.id, sourceProblem: src.problem });
        sLog.info({ sourceId: src.id }, 'continuation injected from prior session');
      }
    } catch (err) {
      sLog.warn({ err: err.message }, 'continuation source unavailable (proceeding without)');
    }
  }

  // Retrieve relevant prior sessions for memory injection. The query embedding
  // spends tokens against the embedding provider; attribute the estimate to
  // this session (HLB-152).
  try {
    onTokenUsage(session.id, 'embedding', { input_tokens: estimateTokens(session.problem || ''), output_tokens: 0 }, { estimated: true });
    const memories = await memory.retrieveSimilar(session.problem, 3);
    if (memories.length > 0) {
      session._memories = memories;
      // Pre-render so lib/context.js can inject without reaching back into
      // the memory manager (which would re-create the dependency it was
      // extracted to avoid).
      session._memoryText = memory.injectMemory(memories);
      stmts.updateSessionMemoryInjected.run(Date.now(), session.id);
      sLog.info({ count: memories.length }, 'memory injected from prior sessions');
      broadcast(session.id, { type: 'memory-injected', sessionId: session.id, count: memories.length });
    }
  } catch (err) {
    sLog.warn({ err: err.message }, 'memory retrieval failed (proceeding without)');
  }

  // Create PhaseRouter
  const router = createRouter();

  // Build agent list per phase (inject specialists into divergence + convergence)
  function getPhaseAgents(phase) {
    const baseAgents = [...phase.agents];
    if (session._specialists && session._specialists.length > 0) {
      // Specialists participate in Divergence and Convergence phases
      if (phase.id === 'divergence' || phase.id === 'convergence') {
        session._specialists.forEach(s => {
          if (!baseAgents.includes(s.id)) baseAgents.push(s.id);
        });
      }
    }
    return baseAgents;
  }

  // Phases the loop actually finished. The completion path reads it to tell a
  // run that reached Synthesis from one that ended early; a resumed run counts
  // the phases that already ran before it.
  let phasesCompleted = resumeFromPhase;
  let abortReason = null;
  let deactivated = false;
  let consecutiveTurnFailures = 0;

  for (let phaseIdx = resumeFromPhase; phaseIdx < PHASES.length; phaseIdx++) {
    if (!session.active) { deactivated = true; break; }
    router.setIndex(phaseIdx);
    const phase = router.current();
    session.phase = phaseIdx;
    stmts.updateSessionPhase.run(phaseIdx, Date.now(), session.id);
    const phaseAgents = getPhaseAgents(phase);
    broadcast(session.id, { type: 'phase-change', phase: phaseIdx, phaseName: phase.name, phaseAgents, sessionId: session.id });

    // Whether every agent of this phase was dispatched. The inner loop's three
    // exits are all early ones, so "ran to its end" is exactly the condition,
    // and it is not the same as "the session is still active": a stop landing
    // during the final agent's turn (synthesis is one agent and minutes long)
    // still leaves that phase finished, with its message written.
    let phaseRanToEnd = true;
    for (const agentId of phaseAgents) {
      if (!session.active) { phaseRanToEnd = false; break; }
      // Only BLOCKING escalations halt the deliberation. Optional ones
      // accumulate in the pending panel and auto-resolve to their stated
      // default at phase end (below) — they never block an agent turn.
      const pending = session.escalations.filter(e => !e.answered && e.severity !== 'optional');
      if (pending.length > 0) {
        broadcast(session.id, { type: 'waiting-for-human', pendingCount: pending.length, sessionId: session.id });
        // F13 — event-driven wait. Each pending escalation gets its own
        // promise resolved by the WS escalation-response handler. Wakeup is
        // immediate (sub-100ms) instead of the prior 2 s polling tick.
        // HLB-148: the live waiter owns the mutable countdown. If the human
        // already paused the card before this phase gate opened, carry that
        // pause onto the fresh waiter so it holds. Then push the authoritative
        // (live) deadline to the client so the card counts down to the real one.
        const waits = pending.map(e => {
          const p = waitForEscalation(session.id, e.id, { timeoutMs: DEFAULT_TIMEOUT_MS });
          if (e.paused === true) pauseEscalation(session.id, e.id);
          const live = getDeadline(session.id, e.id);
          if (live) {
            e.deadlineAt = live.deadlineAt;
            e.paused = live.paused;
            broadcast(session.id, { type: 'escalation-timer-updated', sessionId: session.id, escalationId: e.id, paused: live.paused, deadlineAt: live.deadlineAt });
          }
          return p
            .then(() => ({ id: e.id, status: 'answered' }))
            .catch((err) => ({ id: e.id, status: 'timeout', err }));
        });
        const results = await Promise.all(waits);
        const timedOut = results.filter(r => r.status === 'timeout');
        // A blocking escalation that timed out was never marked answered, so
        // the next agent turn re-armed a fresh 5-minute wait on the same
        // question, and so did every turn after it — one unanswered question
        // could hold a room for over an hour. Close it on its stated default,
        // the way the phase gate closes an optional one. A stop or a delete
        // also surfaces here as a timeout, so only do this while the session
        // is still running.
        if (timedOut.length > 0 && session.active) {
          for (const r of timedOut) {
            const e = pending.find(x => x.id === r.id);
            if (!e || e.answered) continue;
            const ans = defaultAnswerFor(e, '[auto-resolved after timeout]');
            e.answered = true;
            e.answer = ans;
            stmts.answerEscalationBulk.run(ans, Date.now(), e.id);
            broadcast(session.id, { type: 'escalation-answered', escalationId: e.id, answer: ans, sessionId: session.id, autoResolved: true });
          }
          sLog.warn({ count: timedOut.length }, 'escalation wait timed out; resolved to the stated defaults');
          broadcast(session.id, { type: 'escalation-timeout', message: 'Proceeding on the stated defaults (timeout)', sessionId: session.id });
        }
      }
      // A stop or delete during the escalation wait releases the wait (surfaced
      // as a timeout above) but leaves the loop mid-iteration. Recheck before
      // the turn so a stopped or deleted session never runs another agent, and
      // its insertMessage never lands on a row deleteSession already removed.
      if (!session.active) { phaseRanToEnd = false; break; }
      const turnError = await runAgentTurn(session, agentId, phaseIdx);
      // A provider that refuses one turn usually refuses the next: on
      // 2026-08-11 three sessions each drove all 21 turns into a 402/429 storm
      // and produced nothing, in under two minutes and for real money. Stop
      // paying for a room that cannot speak.
      if (!turnError) {
        consecutiveTurnFailures = 0;
      } else if (++consecutiveTurnFailures >= MAX_CONSECUTIVE_TURN_FAILURES) {
        abortReason = turnError;
        sLog.error({ consecutiveTurnFailures, lastError: turnError }, 'aborting deliberation: consecutive agent turns all failed');
        broadcast(session.id, {
          type: 'deliberation-aborted', sessionId: session.id,
          reason: turnError, failedTurns: consecutiveTurnFailures,
        });
        session.active = false;
        phaseRanToEnd = false;
        break;
      }
    }

    // Phase end: auto-resolve any still-open OPTIONAL escalations to their
    // stated default so the next phase proceeds with the resolution recorded
    // and fed back to agents — never silently dropped.
    const unresolvedOptional = session.escalations.filter(e => !e.answered && e.severity === 'optional');
    for (const e of unresolvedOptional) {
      const ans = defaultAnswerFor(e, '[auto-resolved]');
      e.answered = true;
      e.answer = ans;
      stmts.answerEscalationBulk.run(ans, Date.now(), e.id);
      broadcast(session.id, { type: 'escalation-answered', escalationId: e.id, answer: ans, sessionId: session.id, autoResolved: true });
    }

    // Count the phase when every one of its agents was dispatched, even if the
    // stop arrived during the last of them: that phase did finish, and the
    // final synthesis message is already written. Then leave, because the
    // session is no longer running.
    if (phaseRanToEnd) phasesCompleted = phaseIdx + 1;
    if (!session.active) { deactivated = true; break; }
  }

  session.active = false;
  // Did the room reach a verdict, not just reach the phase that produces one.
  const finalPhaseName = PHASES[PHASES.length - 1].name;
  const verdictProduced = session.messages.some(m => m.phase === finalPhaseName);
  const outcome = deliberationOutcome({
    messageCount: session.messages.length,
    phasesCompleted,
    totalPhases: PHASES.length,
    aborted: !!abortReason,
    deactivated,
    verdictProduced,
  });
  stmts.updateSessionActive.run(0, Date.now(), session.id);
  stmts.updateSessionOutcome.run(outcome, outcome === 'failed' ? Date.now() : null, Date.now(), session.id);
  activeSessions.delete(session.id);

  // F11 — Post-synthesis work goes through the durable job table so a
  // crash before completion gets retried, and so a job that throws does
  // not crash the request path.
  jobs.enqueue('memory.storeSessionMemory', { sessionId: session.id });
  jobs.enqueue('memory.extractArchivalFacts', { sessionId: session.id });
  // Only a run that reached the end is scored. Scoring a failed run pollutes
  // the metric with infrastructure failures (B7 / HLB-797); scoring a stopped
  // one dresses a redeploy casualty up as a judged verdict, which is how a
  // three-message session came to carry a quality score of 0.249.
  if (outcome === 'complete') jobs.enqueue('quality.evaluateSession', { sessionId: session.id });

  // HLB-152 — persist the per-session token tally accumulated across all agent
  // turns and tool round-trips. Embedding/memory/quality tokens are added by
  // the post-deliberation jobs above (async); each of those re-persists the
  // cumulative snapshot when it finishes, so this write captures the synchronous
  // portion and the jobs top it up.
  let costSnap = { totalTokens: 0, breakdown: {}, totalCostUsd: 0, costBreakdown: {}, costModes: {} };
  try {
    costSnap = tokenCostSnapshot(session.id);
    persistSessionTokens(db, session.id, tokenLedger, { cost: { total_cost_usd: costSnap.totalCostUsd, cost_breakdown: costSnap.costBreakdown } });
    tokenTick.reset(session.id);
    broadcast(session.id, { type: 'tokens-counted', sessionId: session.id, ...costSnap });
    sLog.info({ totalTokens: costSnap.totalTokens, totalCostUsd: costSnap.totalCostUsd }, 'session token + cost persisted');
  } catch (err) {
    sLog.warn({ err: err && err.message }, 'token persistence failed');
  }

  const synthCount = stmts.synthCountForSession.get(session.id).c;
  const qaCount = stmts.escalationCountForSession.get(session.id).c;
  const totalMsgs = session.messages.length;
  broadcast(session.id, {
    type: 'deliberation-complete', sessionId: session.id,
    outcome,
    totalTokens: costSnap.totalTokens,
    totalCostUsd: costSnap.totalCostUsd,
    export: {
      available: true,
      modes: [
        { id: 'full_transcript', label: 'Full Transcript (A–Z)', available: totalMsgs > 0 },
        { id: 'end_result', label: 'End Result Only', available: synthCount > 0 },
        { id: 'end_result_with_qa', label: 'End Result + Q&A', available: synthCount > 0 || qaCount > 0 },
      ],
      formats: ['txt', 'md', 'json'],
    }
  });
}

// ─── Follow-up Q&A ──────────────────────────────────────────
async function runFollowUp(sessionId, session, question) {
  const responderId = 'process-architect';
  const sessionAgents = getAgentsForSession(session);
  const agent = sessionAgents.find(a => a.id === responderId);
  broadcast(sessionId, { type: 'agent-state', agentId: responderId, state: 'thinking', sessionId });

  try {
    const priorMessages = (session.messages || []).map(m => {
      const a = sessionAgents.find(x => x.id === m.agentId);
      return `[${a ? a.name : m.agentName || 'Agent'}]: ${m.content}`;
    }).join('\n\n');
    const humanHistory = (session.humanMessages || []).map(h => `[Human]: ${h.content}`).join('\n');
    const systemPrompt = `You are the Process Architect responding to a follow-up question after a completed War Room deliberation.\n\nYou have access to the full deliberation history. Answer the human's question directly, drawing on the insights and analysis from all 8 agents' contributions. Be concise, specific, and actionable.\n\nIf the question requires information that wasn't covered in the deliberation, say so and suggest what additional research would help.`;
    const userContent = `ORIGINAL PROBLEM: ${session.problem}\n\nDELIBERATION SUMMARY (all agents' contributions):\n${priorMessages}\n\n${humanHistory ? `HUMAN MESSAGES:\n${humanHistory}\n\n` : ''}FOLLOW-UP QUESTION: ${question}\n\nAnswer this question based on the deliberation above. Be direct and specific.`;
    const response = await callAnthropic(systemPrompt, [{ role: 'user', content: userContent }], responderId, AGENT_MAX_TOKENS,
      (u) => onTokenUsage(sessionId, 'agent_turn', u));
    // A follow-up adds to the session's running total after completion.
    try {
      const cs = tokenCostSnapshot(sessionId);
      persistSessionTokens(db, sessionId, tokenLedger, { cost: { total_cost_usd: cs.totalCostUsd, cost_breakdown: cs.costBreakdown } });
      broadcast(sessionId, { type: 'tokens-counted', sessionId, ...cs });
    } catch (_) { /* non-fatal */ }

    broadcast(sessionId, { type: 'agent-state', agentId: responderId, state: 'speaking', sessionId });
    const now = Date.now();
    const msgId = genId();
    const msg = { id: msgId, agentId: responderId, agentName: agent.name, agentEmoji: agent.emoji, agentColor: agent.color, content: response, phase: 'Follow-up', timestamp: now };
    stmts.insertMessage.run(msgId, sessionId, responderId, agent.name, agent.emoji, agent.color, response, 'Follow-up', now);
    broadcast(sessionId, { type: 'message', ...msg, sessionId });
    broadcast(sessionId, { type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
  } catch (err) {
    log.error({ sessionId, err: err.message }, 'follow-up error');
    broadcast(sessionId, { type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
    broadcast(sessionId, { type: 'error', agentId: responderId, message: `Follow-up failed: ${err.message}`, sessionId });
  }
}

// ─── Wire Modules ───────────────────────────────────────────
const deps = { db, stmts, AGENTS, PHASES, activeSessions, callAnthropic, createSession, loadSession, runDeliberation, runFollowUp, broadcast, broadcastGlobal, memory, quality, fingerprint, specialist, getAgentsForSession, attachFiles, filesServiceClient, escalationTiming };

setupRoutes(app, deps);
setupWebSocket(wss, deps);
setupMCPServer(app, { db, stmts, callLLM: callAnthropic, createSession, loadSession, runDeliberation, activeSessions, AGENTS, PHASES, filesServiceClient, attachFiles, abortSessionWaits, quality, memory, specialist, getAgentsForSession, broadcast, broadcastGlobal, log });

// ─── Background Job Handlers (F11) ──────────────────────────
// Replace the three fire-and-forget post-deliberation calls. The worker
// drains these from the background_jobs table, retrying with backoff.
// HLB-152 — these post-deliberation jobs spend embedding/memory/quality tokens
// after deliberation-complete has already fired. Each re-persists the cumulative
// token snapshot so the sessions row converges on the true grand total once all
// async work has drained. persistSnapshot is overwrite-safe (full cumulative
// tally) and never throws into the job worker.
function persistTokenSnapshot(sessionId) {
  try {
    const cs = tokenCostSnapshot(sessionId);
    persistSessionTokens(db, sessionId, tokenLedger, { cost: { total_cost_usd: cs.totalCostUsd, cost_breakdown: cs.costBreakdown } });
    broadcast(sessionId, { type: 'tokens-counted', sessionId, ...cs });
  } catch (err) {
    log.warn({ sessionId, err: err && err.message }, 'token re-persist failed');
  }
}

jobs.register('memory.storeSessionMemory', async ({ sessionId }) => {
  const r = await memory.storeSessionMemory(sessionId);
  persistTokenSnapshot(sessionId);
  return r;
});
jobs.register('memory.extractArchivalFacts', async ({ sessionId }) => {
  const r = await memory.extractArchivalFacts(sessionId);
  persistTokenSnapshot(sessionId);
  return r;
});
jobs.register('quality.evaluateSession', async ({ sessionId }) => {
  const result = await quality.evaluateSession(sessionId);
  if (result) {
    broadcast(sessionId, { type: 'quality-scored', sessionId, score: result.score, breakdown: result.breakdown });
  }
  persistTokenSnapshot(sessionId);
  return result;
});

let jobWorkerHandle = null;

// ─── Graceful Shutdown ──────────────────────────────────────
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  activeSessions.forEach((session) => {
    session.active = false;
    try { stmts.updateSessionActive.run(0, Date.now(), session.id); } catch (_) {}
    // Stamp the outcome here rather than leaving it to the loop: the process
    // may exit before the parked turn gets another tick, and a row with no
    // outcome reads as a legacy completion. A redeploy is not a verdict.
    try { stmts.updateSessionOutcome.run('stopped', null, Date.now(), session.id); } catch (_) {}
    try { abortSessionWaits(session.id, 'server shutting down'); } catch (_) {}
  });

  // Wait up to 10 s for in-flight LLM calls so an agent turn can finish
  // writing its row before db.close() yanks the file out from under it.
  const start = Date.now();
  while (anyLLMInFlight() && Date.now() - start < 10_000) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (anyLLMInFlight()) {
    log.warn({ inFlight: inFlightLLMCount() }, 'LLM calls still in flight after 10s — closing anyway');
  }

  try { await jobs.stopWorker(jobWorkerHandle); } catch (_) {}
  try { db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ──────────────────────────────────────────────────
(async () => {
  // Files-service health check + legacy migration (BEFORE binding the listener)
  if (filesServiceClient) {
    try {
      await filesServiceClient.health();
      log.info('files-service reachable at startup');
    } catch (err) {
      log.error({ err: err.message }, 'files-service unreachable at startup — aborting');
      process.exit(1);
    }
    try {
      const migrationSummary = await runLegacyFileMigration(db, filesServiceClient);
      if (migrationSummary.failed > 0) {
        log.warn({ summary: migrationSummary }, 'legacy file migration completed with failures');
      }
    } catch (err) {
      log.error({ err: err.message }, 'legacy file migration failed — aborting');
      process.exit(1);
    }
  }

  server.listen(PORT, () => {
  console.log(`\n🏛️  AI Research War Room`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   Database: ${dbPath}`);
  console.log(`   WebSocket ready`);
  console.log(`   Model: ${MODEL}\n`);

  // F4 — boot reconciliation. Anything still flagged active=1 belongs to a
  // previous (crashed) process. Mark it crash-recovered, do NOT auto-resume,
  // tell connected clients so their UI can render the recovery state.
  try {
    const orphaned = stmts.getActiveSessions.all();
    const ts = Date.now();
    for (const row of orphaned) {
      stmts.markCrashRecovered.run(ts, ts, row.id);
      log.warn({ sessionId: row.id }, 'crash-recovered orphaned session');
    }
    if (orphaned.length > 0) {
      broadcastGlobal({ type: 'crash-recovered', sessionIds: orphaned.map(r => r.id) });
    }
  } catch (err) {
    log.error({ err: err && err.message || err }, 'boot reconciliation failed');
  }

  // Start the durable job worker.
  jobWorkerHandle = jobs.runWorker();

  // Retroactive quality scoring on first boot (async, non-blocking)
  quality.retroactiveScore().catch(err =>
    log.warn({ err: err.message }, 'retroactive quality scoring error')
  );

  // Backfill archetypes for completed sessions that pre-date the fingerprint
  // classifier or whose original classification call failed. Async, non-
  // blocking; the LLM calls are throttled inside the helper.
  fingerprint.backfillArchetypes().catch(err =>
    log.warn({ err: err.message }, 'archetype backfill error')
  );

  // Re-price sessions costed under the old rule, which billed everything that
  // was not literally the `subscription` route at metered per-token rates. The
  // helper decides per row from the effective billing config, so a metered
  // deployment rewrites nothing and an operator override is respected; gating
  // on the env-derived mode here would have ignored that override.
  try {
    repriceLegacySessions({
      db, appConfig, costConfig, billingForRoute, amortizedPerToken, electricityPerToken, log,
    });
  } catch (err) {
    log.warn({ err: err.message }, 'cost reprice error');
  }
  });
})();
