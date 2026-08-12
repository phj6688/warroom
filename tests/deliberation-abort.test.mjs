// When the provider refuses every request, the loop used to plough through all
// five phases anyway: on 2026-08-11 three sessions each burned 21 agent turns
// against a 402/429 storm in under two minutes, produced zero messages, and
// cost real money. The room now gives up after a run of consecutive failed
// turns and records the run as failed, so the caller gets a fast, attributable
// end instead of a silent empty transcript.
//
// Drives the real deliberation loop against a local gateway that refuses
// everything, which is the closest reproduction of the incident available
// without spending money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { spawnServer, waitFor } from './_helpers.mjs';

function startRefusingGateway() {
  return new Promise((resolve) => {
    let hits = 0;
    const srv = createServer((req, res) => {
      hits++;
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 20722.' },
      }));
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        srv,
        port: srv.address().port,
        hitCount: () => hits,
        // closeAllConnections first: a keep-alive socket the server under test
        // left open would otherwise hold close() open forever.
        close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
      });
    });
  });
}

test('a deliberation whose every turn is refused aborts instead of burning all five phases', async () => {
  const gateway = await startRefusingGateway();
  const server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      OPENAI_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
      OPENAI_API_KEY: 'test-key',
      // Keep the run short and deterministic: no search, no long waits.
      TAVILY_API_KEY: '',
      SCOUT_USE_TOOL: 'false',
      AGENT_SEARCH_EXPANSION: 'false',
      LLM_TIMEOUT_MS: '5000',
    },
  });
  try {
    const created = await fetch(`${server.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ problem: 'a problem the provider will refuse to think about' }),
    });
    const createdBody = await created.text();
    assert.equal(created.status, 200, `create failed: ${createdBody}`);
    const { id } = JSON.parse(createdBody);

    const db = new Database(server.dbPath, { readonly: true });
    try {
      const row = await waitFor(() => {
        const r = db.prepare('SELECT active, outcome, phase FROM sessions WHERE id = ?').get(id);
        return r && r.active === 0 ? r : null;
      }, { timeoutMs: 40_000, intervalMs: 250, label: 'session to end' });

      assert.equal(row.outcome, 'failed', 'a run the provider refused is failed, not complete');

      const turns = db.prepare(
        "SELECT COUNT(*) c FROM search_metrics WHERE session_id = ? AND event_type = 'agent_turn_complete'"
      ).get(id).c;
      assert.ok(turns > 0, 'the failed turns are recorded for diagnosis');
      assert.ok(turns <= 8, `aborted early, expected at most 8 turns, got ${turns}`);
      assert.ok(row.phase < 4, `stopped before the last phase, got phase ${row.phase}`);

      const msgs = db.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get(id).c;
      assert.equal(msgs, 0, 'no agent produced a message');
    } finally {
      db.close();
    }
  } finally {
    await server.dispose();
    await gateway.close();
  }
});
