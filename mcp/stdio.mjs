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

const BASE_URL = process.env.WAR_ROOM_URL || 'http://localhost:8090';

// ─── HTTP helpers ────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) { const text = await res.text(); throw new Error(`HTTP ${res.status}: ${text}`); }
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`HTTP ${res.status}: ${text}`); }
  return res.json();
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
      messages: s.messages || [],
      escalations: s.escalations || [],
      humanMessages: s.humanMessages || [],
    };
  },
  async createSession(problem, files) {
    const fileObjs = files.map((f, i) => ({
      id: `file-${Date.now()}-${i}`, name: f.name, size: f.content.length, type: 'text/plain', content: f.content,
    }));
    const result = await wsCmd({ type: 'new-session', problem, files: fileObjs });
    if (result.type === 'error') throw new Error(result.message);
    return { id: result.session.id, problem: result.session.problem };
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
  async exportSession(sessionId) {
    const res = await fetch(`${BASE_URL}/api/sessions/${sessionId}/export?mode=full_transcript&format=md`);
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
