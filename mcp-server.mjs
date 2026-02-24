#!/usr/bin/env node
/**
 * War Room MCP Server
 * 
 * Connects to the War Room WebSocket + REST API and exposes
 * standard operations as MCP tools.
 * 
 * Usage (stdio transport):
 *   WAR_ROOM_URL=http://100.115.215.121:8090 node mcp-server.mjs
 * 
 * Tools:
 *   warroom_list_sessions   — list all sessions (recent 50)
 *   warroom_get_session     — get full session with messages
 *   warroom_create_session  — start a new deliberation
 *   warroom_send_message    — inject human message into active session
 *   warroom_answer_escalation — respond to agent escalation
 *   warroom_stop_session    — stop active deliberation
 *   warroom_delete_session  — delete a session permanently
 *   warroom_list_agents     — list all 8 cognitive agents
 *   warroom_get_status      — server health + active session count
 * 
 * Resources:
 *   warroom://sessions           — session list
 *   warroom://agents             — agent definitions
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';

const BASE_URL = process.env.WAR_ROOM_URL || 'http://localhost:8090';

// ─── HTTP helpers ────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// ─── WebSocket command helper ────────────────────────────────
function wsCmd(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proto = BASE_URL.startsWith('https') ? 'wss:' : 'ws:';
    const host = BASE_URL.replace(/^https?:\/\//, '');
    const ws = new WebSocket(`${proto}//${host}`);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); reject(new Error('Timeout')); }
    }, timeoutMs);

    ws.on('open', () => ws.send(JSON.stringify(msg)));

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        const resolveTypes = [
          'session-created', 'session-stopped', 'session-deleted',
          'escalation-answered', 'session-state', 'error'
        ];
        if (resolveTypes.includes(parsed.type)) {
          if (!resolved) {
            resolved = true; clearTimeout(timeout); ws.close();
            resolve(parsed);
          }
        }
      } catch (e) { /* ignore */ }
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
    });
  });
}

// Helper for fire-and-confirm (human-message)
function wsSendAndListen(msg, listenType, matchFn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const proto = BASE_URL.startsWith('https') ? 'wss:' : 'ws:';
    const host = BASE_URL.replace(/^https?:\/\//, '');
    const ws = new WebSocket(`${proto}//${host}`);
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) { resolved = true; ws.close(); resolve(null); }
    }, timeoutMs);

    ws.on('open', () => ws.send(JSON.stringify(msg)));

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === listenType && matchFn(parsed)) {
          if (!resolved) {
            resolved = true; clearTimeout(timeout); ws.close();
            resolve(parsed);
          }
        }
      } catch (e) { /* ignore */ }
    });

    ws.on('error', (err) => {
      if (!resolved) { resolved = true; clearTimeout(timeout); reject(err); }
    });
  });
}

function ok(text) { return { content: [{ type: 'text', text }] }; }
function err(text) { return { content: [{ type: 'text', text }], isError: true }; }

// ─── MCP Server ──────────────────────────────────────────────
const server = new McpServer({
  name: 'war-room',
  version: '1.0.0',
  description: 'AI Research War Room — 8 cognitive agents collaborate through structured deliberation.',
});

// ─── Tools ───────────────────────────────────────────────────

server.tool(
  'warroom_list_sessions',
  'List all War Room sessions (most recent 50). Returns id, problem, phase, status, message count.',
  {},
  async () => {
    try {
      const sessions = await api('/api/sessions');
      if (!sessions.length) return ok('No sessions. Use warroom_create_session to start one.');
      const text = sessions.map(s => {
        const date = new Date(s.createdAt).toISOString().slice(0, 16);
        const status = s.active ? '🟢 ACTIVE' : '✅ Done';
        return `[${s.id}] ${status} | Phase ${s.phase}/4 | ${s.messageCount || 0} msgs | ${date}\n  ${s.problem.slice(0, 120)}`;
      }).join('\n\n');
      return ok(`War Room Sessions (${sessions.length}):\n\n${text}`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_get_session',
  'Get full session detail including all agent messages, escalations, and human interjections.',
  { sessionId: z.string().describe('Session ID') },
  async ({ sessionId }) => {
    try {
      const s = await api(`/api/sessions/${sessionId}`);
      const lines = [
        `Session: ${s.id}`,
        `Problem: ${s.problem}`,
        `Status: ${s.active ? '🟢 Active' : '✅ Complete'} | Phase: ${s.phase}/4`,
        `Created: ${new Date(s.createdAt).toISOString()}`,
        '',
      ];
      if (s.messages?.length) {
        lines.push(`--- Messages (${s.messages.length}) ---\n`);
        s.messages.forEach(m => {
          lines.push(`${m.agentEmoji} ${m.agentName} [${m.phase}]:`);
          lines.push(m.content);
          lines.push('');
        });
      }
      if (s.escalations?.length) {
        lines.push(`--- Escalations (${s.escalations.length}) ---\n`);
        s.escalations.forEach(e => {
          const st = e.answered ? `✅ ${e.answer}` : '⏳ Pending';
          lines.push(`[${e.id}] ${e.agentId}: "${e.question}" → ${st}`);
        });
        lines.push('');
      }
      if (s.humanMessages?.length) {
        lines.push(`--- Human Interjections (${s.humanMessages.length}) ---\n`);
        s.humanMessages.forEach(h => lines.push(`• ${h.content}`));
      }
      return ok(lines.join('\n'));
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_create_session',
  'Start a new deliberation. 8 agents analyze through 5 phases: Framing → Divergence → Convergence → Red Team → Synthesis. Returns session ID; runs async.',
  { problem: z.string().describe('Problem, question, or challenge to deliberate on') },
  async ({ problem }) => {
    try {
      const result = await wsCmd({ type: 'new-session', problem, files: [] });
      if (result.type === 'session-created') {
        return ok(`✅ Session created: ${result.session.id}\n\nProblem: ${result.session.problem}\n\nDeliberation running. Use warroom_get_session to check progress.`);
      }
      if (result.type === 'error') return err(result.message);
      return err(`Unexpected: ${JSON.stringify(result)}`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_send_message',
  'Inject a human message into an active session. Agents in subsequent turns see it as context.',
  {
    sessionId: z.string().describe('Active session ID'),
    message: z.string().describe('Your message to the agents'),
  },
  async ({ sessionId, message }) => {
    try {
      const result = await wsSendAndListen(
        { type: 'human-message', sessionId, content: message },
        'human-message',
        (p) => p.sessionId === sessionId
      );
      return ok(result
        ? `✅ Message delivered to session ${sessionId}.`
        : `✅ Message sent (delivery assumed).`
      );
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_answer_escalation',
  'Respond to an agent escalation question. Unblocks the deliberation.',
  {
    sessionId: z.string().describe('Session ID'),
    escalationId: z.string().describe('Escalation ID to answer'),
    answer: z.string().describe('Your answer'),
  },
  async ({ sessionId, escalationId, answer }) => {
    try {
      const result = await wsCmd({ type: 'escalation-response', sessionId, escalationId, answer });
      if (result.type === 'escalation-answered') return ok(`✅ Escalation answered. Deliberation continues.`);
      return ok(`Response: ${JSON.stringify(result)}`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_stop_session',
  'Stop an active deliberation immediately.',
  { sessionId: z.string().describe('Session ID to stop') },
  async ({ sessionId }) => {
    try {
      await wsCmd({ type: 'stop-session', sessionId });
      return ok(`✅ Session ${sessionId} stopped.`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_delete_session',
  'Permanently delete a session and all its data.',
  { sessionId: z.string().describe('Session ID to delete') },
  async ({ sessionId }) => {
    try {
      await wsCmd({ type: 'delete-session', sessionId });
      return ok(`✅ Session ${sessionId} deleted.`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_list_agents',
  'List all 8 cognitive agents with their roles and thinking hats.',
  {},
  async () => {
    try {
      const agents = await api('/api/agents');
      const text = agents.map(a => `${a.emoji} ${a.name} — ${a.role} (${a.hat})`).join('\n');
      return ok(`War Room Agents:\n\n${text}`);
    } catch (e) { return err(e.message); }
  }
);

server.tool(
  'warroom_get_status',
  'Get War Room server health, session count, and uptime.',
  {},
  async () => {
    try {
      const h = await api('/api/health');
      return ok(`War Room Status:\n• ${h.status}\n• Sessions: ${h.sessions} total, ${h.activeSessions} active\n• Uptime: ${Math.floor(h.uptime / 60)}m`);
    } catch (e) { return err(e.message); }
  }
);

// ─── Resources ───────────────────────────────────────────────

server.resource(
  'sessions-list',
  'warroom://sessions',
  'List of all War Room sessions',
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('/api/sessions'), null, 2) }],
  })
);

server.resource(
  'agents-list',
  'warroom://agents',
  'War Room agent definitions',
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await api('/api/agents'), null, 2) }],
  })
);

// ─── Start ───────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('War Room MCP Server running on stdio');
console.error(`Target: ${BASE_URL}`);
