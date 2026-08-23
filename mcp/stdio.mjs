#!/usr/bin/env node
/**
 * War Room MCP Server — stdio transport
 *
 * Connects to the War Room REST + WebSocket API and exposes
 * all operations as MCP tools via stdio.
 *
 * Usage:
 *   WAR_ROOM_URL=http://localhost:8090 node mcp/stdio.mjs
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { registerTools } = require('./tools.js');
const { mergeRouting } = require('../lib/agent-routing.js');

const BASE_URL = process.env.WAR_ROOM_URL || 'http://localhost:8090';
// Deployments with WAR_ROOM_TOKEN set gate every /api/* route. Without this the
// stdio transport only ever worked against an unauthenticated server.
const WAR_ROOM_TOKEN = process.env.WAR_ROOM_TOKEN || '';

function authHeaders(extra) {
  return {
    ...(WAR_ROOM_TOKEN ? { Authorization: `Bearer ${WAR_ROOM_TOKEN}` } : {}),
    ...(extra || {}),
  };
}

// ─── HTTP helpers ────────────────────────────────────────────
// Every outbound call is bounded. The WS command path this transport used for
// session creation carried a 30s timeout; an un-timed fetch would instead hang
// the tool call forever against an unresponsive server.
const REQUEST_TIMEOUT_MS = 30_000;

// Carries the status so callers can tell "not found" from "unauthorized"
// instead of swallowing every failure as an absent record.
class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

async function apiSend(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

const apiPost = (path, body) => apiSend('POST', path, body);
const apiPut = (path, body) => apiSend('PUT', path, body);

function inferMime(name) {
  const ext = (name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const map = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python', sql: 'text/x-sql', log: 'text/plain' };
  return map[ext] || 'text/plain';
}

// Upload inline text through war-room's files-service proxy, so the stdio
// transport does not need direct network access to files-service.
async function uploadInlineFiles(files) {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([f.content], { type: inferMime(f.name) }), f.name || 'unnamed');
  }
  const res = await fetch(`${BASE_URL}/api/files/upload`, {
    method: 'POST', headers: authHeaders(), body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`file upload failed: HTTP ${res.status}: ${text}`); }
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data?.files || data?.items || []);
  if (!items.length) throw new Error('files-service upload returned no items');
  return items.map(it => it.id || it.file_id);
}

// ─── WebSocket command helper ────────────────────────────────
function wsCmd(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proto = BASE_URL.startsWith('https') ? 'wss:' : 'ws:';
    const host = BASE_URL.replace(/^https?:\/\//, '');
    const ws = new WebSocket(`${proto}//${host}`);
    let resolved = false;
    const timeout = setTimeout(() => { if (!resolved) { resolved = true; ws.close(); reject(new Error('Timeout')); } }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const resolveTypes = ['session-created', 'session-stopped', 'session-deleted', 'escalation-answered', 'session-state', 'error'];
        if (resolveTypes.includes(parsed.type)) {
          if (!resolved) { resolved = true; clearTimeout(timeout); ws.close(); resolve(parsed); }
        }
      } catch (e) { /* ignore */ }
    });
    ws.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });
  });
}

function wsSendAndListen(msg, listenType, matchFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const proto = BASE_URL.startsWith('https') ? 'wss:' : 'ws:';
    const host = BASE_URL.replace(/^https?:\/\//, '');
    const ws = new WebSocket(`${proto}//${host}`);
    let resolved = false;
    const timeout = setTimeout(() => { if (!resolved) { resolved = true; ws.close(); resolve(null); } }, timeoutMs);
    ws.on('open', () => ws.send(JSON.stringify(msg)));
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === listenType && matchFn(parsed)) {
          if (!resolved) { resolved = true; clearTimeout(timeout); ws.close(); resolve(parsed); }
        }
      } catch (e) { /* ignore */ }
    });
    ws.on('error', (err) => { if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); } });
  });
}

// ─── Ops adapter: REST/WS access ────────────────────────────
const ops = {
  async listSessions() {
    const sessions = await api('/api/sessions');
    return sessions.map(s => ({
      id: s.id, problem: s.problem, phase: s.phase,
      phaseName: `Phase ${s.phase}`, active: s.active,
      messageCount: s.messageCount || 0, pendingCount: 0,
      createdAt: s.createdAt,
    }));
  },
  async getSession(sessionId) {
    const s = await api(`/api/sessions/${sessionId}`);
    return {
      id: s.id, problem: s.problem, phase: s.phase,
      phaseName: `Phase ${s.phase}`, active: s.active,
      createdAt: s.createdAt,
      // Both transports render the same Status line from mcp/tools.js. Without
      // these the shared renderer falls back to "Complete" for every inactive
      // session, which is the bug this branch exists to remove.
      outcome: s.outcome ?? null,
      crashRecoveredAt: s.crashRecoveredAt ?? null,
      totalPhases: s.totalPhases ?? null,
      qualityScore: s.qualityScore ?? null,
      totalTokens: s.totalTokens ?? null,
      messages: s.messages || [],
      escalations: s.escalations || [],
      humanMessages: s.humanMessages || [],
    };
  },
  async createSession(problem, files, fileIds, presetId, continuesFromSessionId) {
    const ids = Array.isArray(fileIds) ? [...fileIds] : [];
    if (files && files.length) ids.push(...await uploadInlineFiles(files));
    // Same guards the HTTP transport applies. POST /api/sessions echoes back
    // neither field, and it accepts any string as a continuation target, so
    // without these a typo returns a session reporting a link that is not real.
    if (presetId) {
      const known = (await api('/api/presets')).map(p => p.id);
      if (!known.includes(presetId)) throw new Error(`unknown preset: ${presetId} (known: ${known.join(', ')})`);
    }
    if (continuesFromSessionId) {
      try {
        await api(`/api/sessions/${continuesFromSessionId}`);
      } catch (err) {
        if (err.status === 404) throw new Error(`prior session ${continuesFromSessionId} not found`);
        throw err;
      }
    }
    const session = await apiPost('/api/sessions', {
      problem,
      ...(ids.length ? { file_ids: ids } : {}),
      ...(presetId ? { preset_id: presetId } : {}),
      ...(continuesFromSessionId ? { continuesFromSessionId } : {}),
    });
    return { id: session.id, problem: session.problem, fileIds: ids, presetId: presetId || null, continuesFromSessionId: continuesFromSessionId || null };
  },
  async attachFiles(sessionId, files, fileIds) {
    const ids = Array.isArray(fileIds) ? [...fileIds] : [];
    if (files && files.length) ids.push(...await uploadInlineFiles(files));
    if (!ids.length) throw new Error('No files or file_ids provided');
    const result = await apiPost(`/api/sessions/${sessionId}/files`, { file_ids: ids });
    return { sessionId, fileIds: ids, attached: result.files };
  },
  async getDecisionRecord(sessionId) {
    return api(`/api/sessions/${sessionId}/decision-record`);
  },
  async listPresets() {
    return api('/api/presets');
  },
  async resumeSession(sessionId) {
    const r = await apiPost(`/api/sessions/${sessionId}/resume`);
    return { sessionId: r.sessionId, resumedFromPhase: r.resumedFromPhase };
  },
  async rateSession(sessionId, rating) {
    const r = await apiPost(`/api/sessions/${sessionId}/quality`, { rating });
    return { sessionId, rating: r.rating };
  },
  async getQuality(sessionId) {
    const shadow = await api(`/api/sessions/${sessionId}/shadow`);
    let score = null;
    try {
      score = await api(`/api/sessions/${sessionId}/quality`);
    } catch (err) {
      // Only 404 means "not scored yet", which is a normal state. An auth or
      // server error must not be reported as an unscored session.
      if (err.status !== 404) throw err;
    }
    return {
      sessionId,
      score: score ? score.score : null,
      breakdown: score ? score.breakdown : null,
      evaluatorModel: score ? score.evaluator_model : null,
      // No REST route exposes sessions.synthesis_quality, so the human rating is
      // unavailable over this transport; the HTTP transport reads it directly.
      humanRating: null,
      shadowAnswer: shadow.naive_answer || null,
      hasSynthesis: !!shadow.synthesis,
    };
  },
  async getAnalytics() {
    return api('/api/analytics/quality');
  },
  async semanticSearch(query, limit) {
    const k = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);
    const rows = await api(`/api/sessions/search/semantic?q=${encodeURIComponent(query)}&limit=${k}`);
    return rows.map(s => ({ id: s.id, problem: s.problem, active: !!s.active, createdAt: s.createdAt, similarity: s.similarity }));
  },
  async recallSimilar(query, limit) {
    const k = Math.min(Math.max(parseInt(limit, 10) || 3, 1), 10);
    return api(`/api/memory/similar?q=${encodeURIComponent(query)}&limit=${k}`);
  },
  async improveProblem(problem) {
    const r = await apiPost('/api/improve', { problem });
    return r.improved;
  },
  async listSpecialists() {
    return api('/api/specialists');
  },
  async getSessionAgents(sessionId) {
    return api(`/api/sessions/${sessionId}/agents`);
  },
  async getPhases() {
    const phases = await api('/api/phases');
    return phases.map((p, i) => ({ index: i, id: p.id, name: p.name, agents: p.agents }));
  },
  async getModelConfig() {
    const cfg = await api('/api/settings/agent-routing');
    const agents = (cfg.agents || []).map(a => ({
      ...a,
      configured: (cfg.routing || {})[a.id] || null,
      effective: (cfg.effective || {})[a.id] || { route: null, model: null },
    }));
    return { routes: cfg.routes, available: cfg.available, agents };
  },
  // Read-modify-write: the PUT replaces the whole map, so a one-agent change
  // must merge into what is already stored or it wipes every other override.
  // The merge and its rules come from lib/agent-routing.js, the same module the
  // HTTP transport and the Settings PUT use, so the two adapters cannot drift.
  // Not atomic: a Settings-panel or second-client write landing between the GET
  // and the PUT is overwritten, last-write-wins. Bounding that needs a
  // conditional write on the settings endpoint, which is a separate change.
  // The PUT dry-runs the candidate and answers 409 when it cannot complete a
  // deliberation. That verdict is the tool's answer, not a transport error, so
  // it is unwrapped here into the same { blocked, preflight } shape the
  // in-process transport returns.
  async setModel({ agentId, route, model, clear, force }) {
    const cfg = await api('/api/settings/agent-routing');
    const validIds = new Set((cfg.agents || []).map(a => a.id));
    const targets = agentId === 'all' ? [...validIds] : [agentId];
    for (const id of targets) {
      if (!validIds.has(id)) throw new Error(`unknown agent: ${id} (use warroom_list_agents for valid ids, or "all")`);
    }
    const patch = {};
    for (const id of targets) patch[id] = clear ? null : { route, model };
    const { clean, error } = mergeRouting(cfg.routing || {}, patch, validIds, cfg.routes || []);
    if (error) throw new Error(error);
    const r = await apiPut('/api/settings/agent-routing', { routing: clean, force: !!force });
    if (r && r.error === 'preflight_failed') {
      return { blocked: true, preflight: r.preflight, routing: cfg.routing || {}, changed: [] };
    }
    return { routing: r.routing, changed: targets, preflight: r.preflight || null, forced: !!r.forced };
  },

  async preflight({ routing = null, timeoutMs } = {}) {
    const body = {};
    if (routing) body.routing = routing;
    if (timeoutMs) body.timeoutMs = timeoutMs;
    return apiPost('/api/settings/preflight', body);
  },
  async testModel({ route, model }) {
    if (route && !model) throw new Error('a non-default route requires an explicit model');
    return apiPost('/api/settings/test-connection', { route: route || '', model: model || '' });
  },
  async listModels({ route }) {
    return api(`/api/settings/models${route ? `?route=${encodeURIComponent(route)}` : ''}`);
  },
  async deleteSession(sessionId) {
    await wsCmd({ type: 'delete-session', sessionId });
  },
  async stopSession(sessionId) {
    await wsCmd({ type: 'stop-session', sessionId });
  },
  async sendMessage(sessionId, message) {
    await wsSendAndListen(
      { type: 'human-message', sessionId, content: message },
      'human-message',
      (p) => p.sessionId === sessionId,
    );
  },
  async answerEscalation(escalationId, answer) {
    // Find the session containing this escalation via the API
    const sessions = await api('/api/sessions');
    for (const s of sessions) {
      if (!s.active) continue;
      const detail = await api(`/api/sessions/${s.id}`);
      const esc = (detail.escalations || []).find(e => e.id === escalationId);
      if (esc) {
        await wsCmd({ type: 'escalation-response', sessionId: s.id, escalationId, answer });
        return;
      }
    }
    throw new Error(`Escalation ${escalationId} not found`);
  },
  async getEscalations(sessionId) {
    if (sessionId) {
      const s = await api(`/api/sessions/${sessionId}`);
      return (s.escalations || []).filter(e => !e.answered);
    }
    // All pending across sessions
    const sessions = await api('/api/sessions');
    const pending = [];
    for (const s of sessions) {
      if (!s.active) continue;
      const detail = await api(`/api/sessions/${s.id}`);
      for (const e of (detail.escalations || [])) {
        if (!e.answered) pending.push({ ...e, session_id: s.id });
      }
    }
    return pending;
  },
  async getMessages(sessionId, agentId, phase) {
    const s = await api(`/api/sessions/${sessionId}`);
    let messages = s.messages || [];
    if (agentId) messages = messages.filter(m => m.agentId === agentId);
    if (phase) messages = messages.filter(m => m.phase === phase);
    return messages;
  },
  async askQuestion(sessionId, question) {
    // Send as human message and wait for the follow-up response
    await wsSendAndListen(
      { type: 'human-message', sessionId, content: question },
      'human-message',
      (p) => p.sessionId === sessionId,
    );
    // Wait for the Process Architect follow-up
    await new Promise(r => setTimeout(r, 2000));
    const s = await api(`/api/sessions/${sessionId}`);
    const followUps = (s.messages || []).filter(m => m.phase === 'Follow-up');
    if (followUps.length) return followUps[followUps.length - 1].content;
    return 'Follow-up response pending. Check session for updates.';
  },
  async exportSession(sessionId, mode = 'full_transcript', format = 'md') {
    const res = await fetch(
      `${BASE_URL}/api/sessions/${sessionId}/export?mode=${encodeURIComponent(mode)}&format=${encodeURIComponent(format)}`,
      { headers: authHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return await res.text();
  },
  async searchSessions(query) {
    return await api(`/api/search?q=${encodeURIComponent(query)}`);
  },
  async listAgents() {
    return await api('/api/agents');
  },
  async getStatus() {
    const h = await api('/api/health');
    return `Status: ${h.status}\nSessions: ${h.sessions} total, ${h.activeSessions} active\nUptime: ${Math.floor(h.uptime / 60)}m`;
  },
};

// ─── Resources ──────────────────────────────────────────────
const server = new McpServer({
  name: 'war-room',
  version: '1.0.0',
  description: 'AI Research War Room — 8 cognitive agents collaborate through structured deliberation.',
});

registerTools(server, ops);

server.resource(
  'sessions-list',
  'warroom://sessions',
  { description: 'List of all War Room sessions' },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('/api/sessions'), null, 2) }],
  })
);

server.resource(
  'agents-list',
  'warroom://agents',
  { description: 'War Room agent definitions' },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('/api/agents'), null, 2) }],
  })
);

// ─── Start ──────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('War Room MCP Server running on stdio');
console.error(`Target: ${BASE_URL}`);
