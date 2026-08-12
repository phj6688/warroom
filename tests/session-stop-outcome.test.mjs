// The incident row this branch is named after: session 83be7536 stopped inside
// Problem Framing with three messages and was stored `outcome: complete` with a
// quality score of 0.249. Every production line that fixes it survived a full
// suite revert, because nothing drove a stop all the way to the database.
//
// This does. It runs the real loop against a local gateway, stops the room over
// the real WS path partway through, and reads the row back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { spawnServer, waitFor } from './_helpers.mjs';

// Answers every agent turn slowly enough that a stop lands mid-deliberation
// rather than after it.
function startSlowGateway(delayMs) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'A position on the question at hand.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5 },
        }));
      }, delayMs));
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      port: srv.address().port,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
    }));
  });
}

test('a room stopped mid-deliberation is recorded as stopped, and is not quality scored', async () => {
  const gateway = await startSlowGateway(700);
  const server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      OPENAI_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      OPENAI_API_KEY: 'test-key',
      TAVILY_API_KEY: '',
      SCOUT_USE_TOOL: 'false',
      AGENT_SEARCH_EXPANSION: 'false',
      LLM_TIMEOUT_MS: '10000',
      JOB_WORKER_INTERVAL_MS: '300',
    },
  });
  const db = new Database(server.dbPath, { readonly: true });
  let ws;
  try {
    const created = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem: 'a decision the operator will interrupt partway through' }),
    });
    const body = await created.text();
    assert.equal(created.status, 200, `create failed: ${body}`);
    const sessionId = JSON.parse(body).id;

    // Let the room speak at least once, so this is a stop and not an empty run.
    await waitFor(() => {
      const c = db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c;
      return c > 0 ? c : null;
    }, { timeoutMs: 30_000, intervalMs: 200, label: 'the first agent message' });

    ws = new WebSocket(server.wsUrl);
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ type: 'stop-session', sessionId }));

    // The stop handler writes active=0 immediately; the loop writes the outcome
    // when its in-flight turn returns. Wait for the loop, not the handler.
    const row = await waitFor(() => {
      const r = db.prepare('SELECT active, outcome, phase FROM sessions WHERE id = ?').get(sessionId);
      return r && r.active === 0 && r.outcome ? r : null;
    }, { timeoutMs: 30_000, intervalMs: 200, label: 'the deliberation loop to record an outcome' });

    assert.equal(row.outcome, 'stopped', 'a stop is not a completion');
    assert.ok(row.phase < 4, `stopped before the last phase, got phase ${row.phase}`);
    assert.ok(
      db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(sessionId).c > 0,
      'the room did speak, so this is a stop and not a failed run'
    );

    // The quality job must never run for it. Give the worker several ticks:
    // a score appearing later is exactly the 0.249 defect.
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM quality_scores WHERE session_id = ?').get(sessionId).c, 0,
      'a stopped run must not be quality scored'
    );
    assert.equal(
      db.prepare('SELECT quality_score FROM sessions WHERE id = ?').get(sessionId).quality_score, null,
      'and must not carry a score on its row'
    );
  } finally {
    try { if (ws) ws.close(); } catch { /* already gone */ }
    db.close();
    await server.dispose();
    await gateway.close();
  }
});
