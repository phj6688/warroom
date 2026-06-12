/**
 * HLB-152 R2/R3/R4 — end-to-end token accounting against a real server.
 *
 * Spawns the War Room server pointed at a fake OpenAI-compatible gateway that
 * answers every completion instantly with a fixed body + usage. Drives a full
 * deliberation through POST /api/sessions, waits for deliberation-complete over
 * the WebSocket, then asserts:
 *   - the sessions row has a non-zero total_tokens and a token_breakdown JSON
 *     with non-zero agent-turn tokens (R4 DB side-effect);
 *   - /api/sessions surfaces totalTokens on the session payload (R4 payload);
 *   - the grand total equals the sum of the breakdown buckets (R2 shape).
 *
 * Embeddings hit Ollama, which is not available in CI; the server degrades
 * gracefully and the query-embedding estimate still lands a non-zero embedding
 * figure. The exact total depends on agent count, so the assertions check
 * structure and the sum invariant rather than a fixed number.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnServer, waitFor, delay } from './_helpers.mjs';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));

// Per-completion usage the fake gateway reports. Small + fixed so the totals
// are deterministic given the (variable) number of agent turns.
const FAKE_USAGE = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

let gateway;
let gatewayUrl;
let server;

before(async () => {
  gateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: 'A concise deliberation contribution with a clear recommendation.' },
          finish_reason: 'stop',
        }],
        usage: FAKE_USAGE,
      }));
    });
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${gateway.address().port}/v1`;

  server = await spawnServer({
    env: {
      OPENAI_BASE_URL: gatewayUrl,
      OPENAI_API_KEY: 'stub-key',
      // No TAVILY → research scout uses the prose-marker path (no live search),
      // keeping the deliberation deterministic and fast.
      SEARCH_PROVIDER: 'tavily',
      TAVILY_API_KEY: '',
      // Point embeddings at an unreachable host so the call fails fast and the
      // server degrades gracefully instead of hanging on a 10s timeout.
      EMBEDDING_URL: 'http://127.0.0.1:1/api/embed',
    },
    readyTimeoutMs: 15000,
  });
});

after(async () => {
  await server?.dispose();
  await new Promise(r => gateway?.close(r));
});

describe('token accounting: full deliberation persists a per-session total', () => {
  test('total_tokens + token_breakdown land on the row and the payload', async () => {
    // Subscribe over WS so we catch deliberation-complete for our session.
    const ws = new WebSocket(server.wsUrl);
    const events = [];
    let sessionId = null;
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', (raw) => {
      let m = null;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      events.push(m);
    });

    // Create the session via HTTP. Subscribe to its id as soon as we have it.
    const res = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ problem: 'Should our small team adopt a monorepo or keep separate repositories for our three services?' }),
    });
    assert.equal(res.status, 200, 'session created');
    const created = await res.json();
    sessionId = created.id;
    ws.send(JSON.stringify({ type: 'subscribe', sessionId }));

    // Wait for the deliberation to complete. A stubbed gateway makes each turn
    // near-instant, but there are ~16 turns across 5 phases plus meta calls.
    const complete = await waitFor(
      () => events.find(e => e.type === 'deliberation-complete' && e.sessionId === sessionId),
      { timeoutMs: 60000, intervalMs: 200, label: 'deliberation-complete' }
    );
    assert.ok(complete, 'deliberation completed');
    assert.ok(typeof complete.totalTokens === 'number' && complete.totalTokens > 0,
      `deliberation-complete carries a positive totalTokens (got ${complete.totalTokens})`);

    // Give the post-deliberation jobs a moment to re-persist (memory/quality).
    await delay(1500);

    // DB side-effect: read the row directly.
    const db = new Database(server.dbPath, { readonly: true });
    const row = db.prepare('SELECT total_tokens, token_breakdown FROM sessions WHERE id = ?').get(sessionId);
    db.close();
    ws.close();

    assert.ok(row, 'session row exists');
    assert.ok(row.total_tokens > 0, `total_tokens persisted positive (got ${row.total_tokens})`);
    assert.ok(row.token_breakdown, 'token_breakdown JSON persisted');
    const bd = JSON.parse(row.token_breakdown);

    // Agent turns dominate; assert that bucket is non-zero (R2).
    assert.ok(bd.agent_turn && bd.agent_turn.total_tokens > 0, 'agent-turn tokens recorded');
    assert.ok(bd.agent_turn.calls > 0, 'agent-turn call count recorded');

    // Grand total equals the sum of every bucket (R2 invariant).
    const sumBuckets = Object.values(bd).reduce((n, c) => n + (c.total_tokens || 0), 0);
    assert.equal(row.total_tokens, sumBuckets, 'total equals the sum of breakdown buckets');

    // The number of agent-turn LLM calls × FAKE_USAGE.total must be a lower
    // bound on agent-turn tokens (each agent turn is one prose-marker call).
    assert.equal(bd.agent_turn.total_tokens, bd.agent_turn.calls * FAKE_USAGE.total_tokens,
      'agent-turn total matches calls × per-call usage');

    // Payload surfaces the total (R4).
    const listRes = await fetch(`${server.baseUrl}/api/sessions`);
    const list = await listRes.json();
    const payload = list.find(s => s.id === sessionId);
    assert.ok(payload, 'session present in /api/sessions');
    assert.equal(payload.totalTokens, row.total_tokens, 'payload totalTokens matches the row');
    assert.ok(payload.tokenBreakdown && payload.tokenBreakdown.agent_turn, 'payload carries tokenBreakdown');
  });
});
