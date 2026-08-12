// The branch's headline fix had no transport-level coverage: reverting
// mcp/http.js answerEscalation to the broken version (persist the answer, never
// resolve the waiter) left the whole suite green, because nothing called
// warroom_answer_escalation against a room that was actually parked.
//
// These two drive the real deliberation loop against a local gateway that makes
// the first agent raise a BLOCKING escalation, then park the room at the next
// phase gate. One answers over MCP and asserts the room wakes; the other
// answers nothing and asserts the stated default releases it instead of
// re-blocking every later turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawnServer, waitFor } from './_helpers.mjs';

const ESCALATION_Q = 'Which budget ceiling should the room assume?';
const ESCALATION_DEFAULT = 'Assume the stated 10k ceiling.';

// A gateway that answers every agent turn, and makes exactly the first one
// raise a blocking escalation. Only agent turns carry the escalate_to_human
// tool, which is what separates them from the classifier call.
function startEscalatingGateway() {
  return new Promise((resolve) => {
    let escalationSent = false;
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* classifier probe */ }
        const isAgentTurn = (body.tools || []).some(t => t.function && t.function.name === 'escalate_to_human');
        const message = { role: 'assistant', content: 'A considered position on the question at hand.' };
        if (isAgentTurn && !escalationSent) {
          escalationSent = true;
          message.tool_calls = [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'escalate_to_human',
              arguments: JSON.stringify({ question: ESCALATION_Q, severity: 'blocking', default_action: ESCALATION_DEFAULT }),
            },
          }];
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
    }));
  });
}

async function startRoom(extraEnv, mcpKey) {
  const gateway = await startEscalatingGateway();
  const server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      MCP_API_KEY: mcpKey,
      OPENAI_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      OPENAI_API_KEY: 'test-key',
      TAVILY_API_KEY: '',
      SCOUT_USE_TOOL: 'false',
      AGENT_SEARCH_EXPANSION: 'false',
      LLM_TIMEOUT_MS: '5000',
      ...extraEnv,
    },
  });
  const created = await fetch(`${server.baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ problem: 'a decision the room will want a human ruling on' }),
  });
  const text = await created.text();
  assert.equal(created.status, 200, `create failed: ${text}`);
  return { gateway, server, sessionId: JSON.parse(text).id };
}

test('answering over MCP wakes a room parked on a blocking escalation', async () => {
  const mcpKey = 'test-mcp-key-escalation-wake';
  // A long window: if the answer does not release the waiter, the room stays
  // parked far past this test's patience, which is exactly the reported bug.
  const { gateway, server, sessionId } = await startRoom({ ESCALATION_TIMEOUT_MS: '600000' }, mcpKey);
  const db = new Database(server.dbPath, { readonly: true });
  const client = new Client({ name: 'escalation-wake-test', version: '1.0.0' });
  let parked = false;
  const ws = new WebSocket(`${server.wsUrl}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join-session', sessionId })));
  ws.on('message', (raw) => {
    let m = {};
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'waiting-for-human') parked = true;
  });
  try {
    // The room has to be genuinely PARKED before the answer proves anything.
    // Answering earlier also worked under the old code, which set the in-memory
    // flag, so the phase gate simply never parked. The bug only bites once the
    // waiter exists, which is the real case: the caller polls, then answers.
    // `waiting-for-human` is the server's own announcement that it is parked.
    await waitFor(() => parked, { timeoutMs: 30_000, intervalMs: 100, label: 'the room to park on the escalation' });

    const esc = db.prepare(
      "SELECT id, severity FROM escalations WHERE session_id = ? AND status = 'pending'"
    ).get(sessionId);
    assert.ok(esc, 'a pending escalation exists while the room is parked');
    assert.equal(esc.severity, 'blocking', 'the gateway raised a blocking escalation');
    const parkedAt = db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c;

    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${mcpKey}`)));
    const res = await client.callTool({
      name: 'warroom_answer_escalation',
      arguments: { escalationId: esc.id, answer: 'Use the 10k ceiling.' },
    });
    const text = (res.content || []).map(c => c.text || '').join('\n');
    assert.match(text, /Deliberation resumed/, 'the tool must report that it released a parked room');

    await waitFor(() => {
      const now = db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c;
      return now > parkedAt ? now : null;
    }, { timeoutMs: 20_000, intervalMs: 250, label: 'the room to resume after the answer' });

    const row = db.prepare('SELECT status, answer FROM escalations WHERE id = ?').get(esc.id);
    assert.equal(row.status, 'answered');
    assert.equal(row.answer, 'Use the 10k ceiling.');
  } finally {
    try { ws.close(); } catch { /* already gone */ }
    await client.close().catch(() => {});
    db.close();
    await server.dispose();
    await gateway.close();
  }
});

test('an unanswered blocking escalation resolves to its stated default and the room carries on', async () => {
  const mcpKey = 'test-mcp-key-escalation-timeout';
  const { gateway, server, sessionId } = await startRoom({ ESCALATION_TIMEOUT_MS: '1200' }, mcpKey);
  const db = new Database(server.dbPath, { readonly: true });
  try {
    const esc = await waitFor(() => db.prepare(
      "SELECT id FROM escalations WHERE session_id = ? AND status = 'pending'"
    ).get(sessionId), { timeoutMs: 30_000, intervalMs: 200, label: 'a blocking escalation to be raised' });

    // Answer nothing. The room must resolve it to the agent's stated default
    // rather than re-arming a fresh window on every later turn.
    const resolved = await waitFor(() => {
      const r = db.prepare('SELECT status, answer, bulk_resolved FROM escalations WHERE id = ?').get(esc.id);
      return r && r.status === 'answered' ? r : null;
    }, { timeoutMs: 30_000, intervalMs: 250, label: 'the escalation to auto-resolve' });

    assert.equal(resolved.status, 'answered');
    assert.match(resolved.answer, /auto-resolved after timeout/, 'closed on the timeout path');
    assert.match(resolved.answer, new RegExp(ESCALATION_DEFAULT.slice(0, 20)), "carries the agent's stated default");

    // And the room got through the whole deliberation instead of re-blocking:
    // one unresolved question used to cost a fresh five-minute wait per turn.
    const row = await waitFor(() => {
      const r = db.prepare('SELECT active, outcome FROM sessions WHERE id = ?').get(sessionId);
      return r && r.active === 0 ? r : null;
    }, { timeoutMs: 60_000, intervalMs: 500, label: 'the deliberation to finish' });
    assert.equal(row.outcome, 'complete', 'the room reached the end on the stated default');
  } finally {
    db.close();
    await server.dispose();
    await gateway.close();
  }
});
