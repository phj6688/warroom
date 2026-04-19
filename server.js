const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const crypto = require('crypto');

// ─── Modules ────────────────────────────────────────────────
const { db, stmts, dbPath } = require('./db');
const { AGENTS, getAgentsForSession } = require('./lib/agents');
const { PHASES, createRouter } = require('./lib/phases');
const { callAnthropic, anyLLMInFlight, inFlightLLMCount } = require('./lib/llm');
const { setupRoutes } = require('./lib/routes');
const { setupWebSocket } = require('./lib/ws-handler');
const { requireAuthWS } = require('./lib/auth');
const { setupMCPServer } = require('./mcp/http');
const { createMemoryManager } = require('./lib/memory');
const { createQualityManager } = require('./lib/quality');
const { createFingerprintClassifier } = require('./lib/fingerprint');
const { createSpecialistSpawner } = require('./lib/specialist');
const { countTokens, trimContext, contextBudget } = require('./lib/tokens');
const { buildContext } = require('./lib/context');
const { createContentBlockBuilder } = require('./lib/prompt/content-blocks');
const { createFilesServiceClient } = require('./lib/clients/files-service');
const { runLegacyFileMigration } = require('./lib/migrate-files');
const jobs = require('./lib/jobs');
const { log, withSession } = require('./lib/logger');
const { waitForEscalation, abortSessionWaits } = require('./lib/escalation');

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
const GATEWAY_URL = process.env.OPENAI_BASE_URL || null;
const GATEWAY_TOKEN = process.env.OPENAI_API_KEY || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
const SEARCH_MAX_RESULTS = parseInt(process.env.SEARCH_MAX_RESULTS || '5');

if (GATEWAY_URL && GATEWAY_TOKEN) {
  log.info({ gateway: GATEWAY_URL }, 'LLM proxy: OpenAI-compatible Gateway');
} else if (ANTHROPIC_API_KEY) {
  log.info({ keyPrefix: ANTHROPIC_API_KEY.slice(0, 12) }, 'LLM: Direct Anthropic API');
} else {
  log.warn('No LLM config — set OPENAI_BASE_URL+TOKEN or ANTHROPIC_API_KEY');
}

if (TAVILY_API_KEY) {
  log.info('Search: Tavily API configured (Research Scout enabled)');
} else {
  log.warn('No TAVILY_API_KEY — Research Scout will operate without live search');
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
const memory = createMemoryManager({ db, stmts, callAnthropic, AGENTS, PHASES });
const quality = createQualityManager({ db, stmts, callAnthropic, PHASES });
const fingerprint = createFingerprintClassifier({ callAnthropic, db, stmts });
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

async function createSession(problem, fileIds = []) {
  const id = genId();
  const now = Date.now();
  stmts.insertSession.run(id, problem, now, now);

  let files = [];
  if (fileIds.length > 0) {
    files = await attachFiles(id, fileIds);
  }

  const session = {
    id, problem, phase: 0,
    messages: [], humanMessages: [], escalations: [],
    agentStates: {}, active: true, createdAt: now,
    _hasFiles: files.length > 0,
  };
  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  activeSessions.set(id, session);

  // Generate shadow (adversarial twin) answer async, non-blocking
  quality.generateShadowAnswer(id, problem).catch(err =>
    log.warn({ sessionId: id, err: err.message }, 'shadow generation error')
  );

  return session;
}

function loadSession(id) {
  const row = stmts.getSession.get(id);
  if (!row) return null;
  const messages = stmts.getSessionMessages.all(id).map(m => ({
    id: m.id, agentId: m.agent_id, agentName: m.agent_name,
    agentEmoji: m.agent_emoji, agentColor: m.agent_color,
    content: m.content, phase: m.phase, timestamp: m.created_at
  }));
  const escalations = stmts.getSessionEscalations.all(id).map(e => ({
    id: e.id, agentId: e.agent_id, agentName: e.agent_name, agentEmoji: e.agent_emoji,
    question: e.question, sessionId: id, answered: e.status === 'answered',
    answer: e.answer, createdAt: e.created_at
  }));
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
  };
}

// ─── Tavily Search ──────────────────────────────────────────
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: SEARCH_MAX_RESULTS, search_depth: 'basic', include_answer: true }),
    });
    if (!res.ok) { log.error({ status: res.status, body: await res.text() }, 'tavily search error'); return null; }
    return await res.json();
  } catch (err) { log.error({ err: err.message }, 'tavily search failed'); return null; }
}

function extractSearchQueries(text) {
  const queries = [];
  const regex = /SEARCH:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const q = match[1].trim().replace(/^\[|\]$/g, '');
    if (q.length > 2) queries.push(q);
  }
  return queries.slice(0, 5);
}

async function executeSearches(queries) {
  const results = [];
  for (const query of queries) {
    const data = await tavilySearch(query);
    if (data) {
      results.push({
        query, answer: data.answer || null,
        sources: (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 500), score: r.score })),
      });
    } else {
      results.push({ query, answer: null, sources: [], error: 'Search unavailable' });
    }
  }
  return results;
}

function formatSearchResults(results) {
  if (!results.length) return '';
  let text = '\n\n=== SEARCH RESULTS ===\n';
  results.forEach((r, i) => {
    text += `\n--- Search ${i + 1}: "${r.query}" ---\n`;
    if (r.error) { text += `[Search unavailable]\n`; return; }
    if (r.answer) text += `Summary: ${r.answer}\n`;
    if (r.sources.length) {
      text += `Sources:\n`;
      r.sources.forEach((s, j) => { text += `  ${j + 1}. ${s.title}\n     ${s.url}\n     ${s.snippet}\n`; });
    }
  });
  text += '\n=== END SEARCH RESULTS ===\n';
  return text;
}

function extractEscalations(text, agentId, sessionId) {
  const escalations = [];
  const xmlRegex = /<need_human_input>\s*([\s\S]+?)\s*<\/need_human_input>/gi;
  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    const q = match[1].trim();
    if (q) escalations.push({ id: genId(), agentId, question: q, sessionId, answered: false, answer: null, createdAt: Date.now() });
  }
  // Back-compat: still accept the legacy flat marker so in-flight sessions or
  // older prompt bleedthrough don't silently drop questions.
  const legacy = /NEED_HUMAN_INPUT:\s*(.+?)(?:\n|$)/g;
  while ((match = legacy.exec(text)) !== null) {
    const q = match[1].trim();
    if (q) escalations.push({ id: genId(), agentId, question: q, sessionId, answered: false, answer: null, createdAt: Date.now() });
  }
  return escalations;
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

    let response = await callAnthropic(agent.systemPrompt, messages, agentId);

    if (isResearchScout && TAVILY_API_KEY) {
      const searchQueries = extractSearchQueries(response);
      if (searchQueries.length > 0) {
        session.agentStates[agentId] = 'searching';
        broadcast(session.id, { type: 'agent-state', agentId, state: 'searching', sessionId: session.id });
        broadcast(session.id, { type: 'search-started', agentId, queries: searchQueries, sessionId: session.id });
        sLog.info({ queries: searchQueries }, 'research scout searching');
        const searchResults = await executeSearches(searchQueries);
        const resultsText = formatSearchResults(searchResults);
        broadcast(session.id, { type: 'search-complete', agentId, resultCount: searchResults.reduce((n, r) => n + r.sources.length, 0), sessionId: session.id });
        session.agentStates[agentId] = 'thinking';
        broadcast(session.id, { type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });
        const synthesisMessages = [
          ...messages,
          { role: 'assistant', content: response },
          { role: 'user', content: `Your search queries have been executed. Here are the results:${resultsText}\n\nNow synthesize these findings into a comprehensive research brief for the team. Include:\n1. Key findings from the search results\n2. Source quality assessment\n3. How this information relates to the problem\n4. Remaining knowledge gaps\n\nDo NOT include any SEARCH: markers in this response.` },
        ];
        response = await callAnthropic(agent.systemPrompt, synthesisMessages, agentId);
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

    const escalations = extractEscalations(response, agentId, session.id);
    escalations.forEach(esc => {
      session.escalations.push(esc);
      stmts.insertEscalation.run(esc.id, session.id, agentId, agent.name, agent.emoji, esc.question, esc.createdAt);
      broadcast(session.id, { type: 'escalation', ...esc, agentName: agent.name, agentEmoji: agent.emoji });
    });

    session.agentStates[agentId] = 'idle';
    broadcast(session.id, { type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    sLog.error({ agentId, err: err.message }, 'agent turn error');
    session.agentStates[agentId] = 'idle';
    broadcast(session.id, { type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    broadcast(session.id, { type: 'error', agentId, message: `${agent.name} encountered an error: ${err.message}`, sessionId: session.id });
  }
}

// ─── Deliberation Loop ─────────────────────────────────────
async function runDeliberation(session, resumeFromPhase = 0) {
  const sLog = withSession(session.id);
  // Fingerprint classification + specialist spawning (before Phase 0)
  if (resumeFromPhase > 0) {
    sLog.info({ resumeFromPhase, totalPhases: PHASES.length }, 'resuming deliberation');
  }
  try {
    const classification = await fingerprint.classify(session.problem);
    if (classification.archetype && classification.confidence >= fingerprint.MIN_CONFIDENCE) {
      sLog.info({
        archetype: classification.archetype,
        confidence: classification.confidence,
        specialists: classification.recommendedSpecialists,
      }, 'fingerprint classified');
      stmts.updateSessionArchetype.run(classification.archetype, Date.now(), session.id);

      // Store archetype
      const now = Date.now();
      stmts.insertArchetype.run(classification.archetype, classification.archetype, classification.reasoning, now, now);
      stmts.insertSessionArchetype.run(session.id, classification.archetype, classification.confidence);

      // Spawn specialists
      if (classification.recommendedSpecialists.length > 0) {
        const specialists = specialist.spawnSpecialists(classification.recommendedSpecialists);
        if (specialists.length > 0) {
          session._specialists = specialists;
          stmts.updateSessionSpecialists.run(JSON.stringify(specialists.map(s => s.id)), Date.now(), session.id);
          // Initialize specialist agent states
          specialists.forEach(s => { session.agentStates[s.id] = 'idle'; });
          // Broadcast updated agent list — global so dashboards refresh.
          const allAgents = getAgentsForSession(session);
          broadcastGlobal({ type: 'agents', agents: allAgents.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat, isSpecialist: !!a.isSpecialist })) });
        }
      }
    } else {
      sLog.info({ confidence: classification.confidence }, 'fingerprint: no confident archetype, proceeding with core 8');
    }
  } catch (err) {
    sLog.warn({ err: err.message }, 'fingerprint classification error (proceeding with core 8)');
  }

  // Retrieve relevant prior sessions for memory injection
  try {
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

  for (let phaseIdx = resumeFromPhase; phaseIdx < PHASES.length; phaseIdx++) {
    if (!session.active) break;
    router.setIndex(phaseIdx);
    const phase = router.current();
    session.phase = phaseIdx;
    stmts.updateSessionPhase.run(phaseIdx, Date.now(), session.id);
    const phaseAgents = getPhaseAgents(phase);
    broadcast(session.id, { type: 'phase-change', phase: phaseIdx, phaseName: phase.name, phaseAgents, sessionId: session.id });

    for (const agentId of phaseAgents) {
      if (!session.active) break;
      const pending = session.escalations.filter(e => !e.answered);
      if (pending.length > 0) {
        broadcast(session.id, { type: 'waiting-for-human', pendingCount: pending.length, sessionId: session.id });
        // F13 — event-driven wait. Each pending escalation gets its own
        // promise resolved by the WS escalation-response handler. Wakeup is
        // immediate (sub-100ms) instead of the prior 2 s polling tick.
        const waits = pending.map(e =>
          waitForEscalation(session.id, e.id, { timeoutMs: 300_000 })
            .then(() => ({ id: e.id, status: 'answered' }))
            .catch((err) => ({ id: e.id, status: 'timeout', err }))
        );
        const results = await Promise.all(waits);
        const timedOut = results.filter(r => r.status === 'timeout');
        if (timedOut.length > 0) {
          sLog.warn({ count: timedOut.length }, 'escalation wait timed out, proceeding without input');
          broadcast(session.id, { type: 'escalation-timeout', message: 'Proceeding without human input (timeout)', sessionId: session.id });
        }
      }
      await runAgentTurn(session, agentId, phaseIdx);
    }
  }

  session.active = false;
  stmts.updateSessionActive.run(0, Date.now(), session.id);
  activeSessions.delete(session.id);

  // F11 — Post-synthesis work goes through the durable job table so a
  // crash before completion gets retried, and so a job that throws does
  // not crash the request path.
  jobs.enqueue('memory.storeSessionMemory', { sessionId: session.id });
  jobs.enqueue('memory.extractArchivalFacts', { sessionId: session.id });
  jobs.enqueue('quality.evaluateSession', { sessionId: session.id });

  const synthCount = stmts.synthCountForSession.get(session.id).c;
  const qaCount = stmts.escalationCountForSession.get(session.id).c;
  const totalMsgs = session.messages.length;
  broadcast(session.id, {
    type: 'deliberation-complete', sessionId: session.id,
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
    const response = await callAnthropic(systemPrompt, [{ role: 'user', content: userContent }], responderId);

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
const deps = { db, stmts, AGENTS, PHASES, activeSessions, callAnthropic, createSession, loadSession, runDeliberation, runFollowUp, broadcast, broadcastGlobal, memory, quality, fingerprint, specialist, getAgentsForSession, attachFiles, filesServiceClient };

setupRoutes(app, deps);
setupWebSocket(wss, deps);
setupMCPServer(app, { stmts, callLLM: callAnthropic, createSession, runDeliberation, activeSessions, AGENTS, PHASES, filesServiceClient, attachFiles });

// ─── Background Job Handlers (F11) ──────────────────────────
// Replace the three fire-and-forget post-deliberation calls. The worker
// drains these from the background_jobs table, retrying with backoff.
jobs.register('memory.storeSessionMemory', ({ sessionId }) => memory.storeSessionMemory(sessionId));
jobs.register('memory.extractArchivalFacts', ({ sessionId }) => memory.extractArchivalFacts(sessionId));
jobs.register('quality.evaluateSession', async ({ sessionId }) => {
  const result = await quality.evaluateSession(sessionId);
  if (result) {
    broadcast(sessionId, { type: 'quality-scored', sessionId, score: result.score, breakdown: result.breakdown });
  }
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
  });
})();
