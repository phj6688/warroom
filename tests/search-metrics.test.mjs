/**
 * Unit tests for lib/metrics/search-metrics.js — the synchronous
 * SQLite sink. Uses the runNodeScript subprocess pattern so we do NOT
 * import better-sqlite3 or the metrics module into the test process.
 *
 * Gates:
 *   - `record` writes every column; nullable defaults are preserved.
 *   - Each event_type round-trips through the schema.
 *   - Two sinks against the same DB file coexist without deadlock.
 *   - tierForAgent: known agents map to correct tiers, unknown → 'D'.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const MIG_PATH = path.join(REPO_ROOT, 'migrations', '015_search_metrics.sql');
const SINK = path.join(REPO_ROOT, 'lib', 'metrics', 'search-metrics.js');

function tempDbPath() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warroom-metrics-'));
  return { dir, dbPath: path.join(dir, 'warroom.db') };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function runScript(body) {
  const script = `
    'use strict';
    const Database = require('better-sqlite3');
    const fs = require('fs');
    const path = require('path');
    const sink = require(${JSON.stringify(SINK)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('search-metrics: sink basics', () => {
  test('record writes all columns and returns rowid; defaults stay null', async () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const { parsed, stdout, stderr } = await runScript(`
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const s = sink.createMetricsSink(db);
        const id = s.record({
          sessionId: 'S1',
          agentId: 'research-scout',
          eventType: 'tool_call',
          path: 'tool_use',
          queriesEmitted: 3,
          queriesExecuted: 3,
          truncated: false,
          latencyMs: 120,
          provider: 'tavily',
          createdAt: 1700000000000,
        });
        const row = db.prepare('SELECT * FROM search_metrics WHERE id = ?').get(id);
        process.stdout.write(JSON.stringify({ ok: true, id, row }));
        db.close();
      `);
      assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
      assert.ok(Number.isFinite(parsed.id));
      assert.equal(parsed.row.session_id, 'S1');
      assert.equal(parsed.row.agent_id, 'research-scout');
      assert.equal(parsed.row.agent_tier, 'A');
      assert.equal(parsed.row.path, 'tool_use');
      assert.equal(parsed.row.event_type, 'tool_call');
      assert.equal(parsed.row.queries_emitted, 3);
      assert.equal(parsed.row.queries_executed, 3);
      assert.equal(parsed.row.truncated, 0);
      assert.equal(parsed.row.latency_ms, 120);
      assert.equal(parsed.row.provider, 'tavily');
      assert.equal(parsed.row.created_at, 1700000000000);
      assert.equal(parsed.row.rounds_used, null);
      assert.equal(parsed.row.synthesis_chars, null);
      assert.equal(parsed.row.error, null);
      assert.equal(parsed.row.budget_exhausted_terminal, null);
    } finally {
      cleanup(dir);
    }
  });

  test('each event_type round-trips (agent_turn_complete, tool_call, budget_truncation, session_budget_exhausted, handler_error)', async () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const { parsed, stdout, stderr } = await runScript(`
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const s = sink.createMetricsSink(db);
        const types = ['agent_turn_complete', 'tool_call', 'budget_truncation', 'session_budget_exhausted', 'handler_error'];
        for (const t of types) {
          s.record({ sessionId: 'S', agentId: 'red-teamer', eventType: t, path: 'tool_use' });
        }
        const rows = db.prepare("SELECT event_type FROM search_metrics ORDER BY id").all();
        process.stdout.write(JSON.stringify({ ok: true, rows }));
        db.close();
      `);
      assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
      assert.deepEqual(parsed.rows.map(r => r.event_type), [
        'agent_turn_complete', 'tool_call', 'budget_truncation', 'session_budget_exhausted', 'handler_error',
      ]);
    } finally {
      cleanup(dir);
    }
  });

  test('unknown event_type throws; invalid path throws', async () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const { parsed, stdout, stderr } = await runScript(`
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const s = sink.createMetricsSink(db);
        let e1 = null, e2 = null;
        try { s.record({ sessionId: 'S', agentId: 'a', eventType: 'nope' }); } catch (err) { e1 = err.message; }
        try { s.record({ sessionId: 'S', agentId: 'a', eventType: 'tool_call', path: 'bogus' }); } catch (err) { e2 = err.message; }
        process.stdout.write(JSON.stringify({ ok: true, e1, e2 }));
        db.close();
      `);
      assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
      assert.match(parsed.e1, /event_type/);
      assert.match(parsed.e2, /path/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('search-metrics: concurrent sinks on same DB', () => {
  test('two sinks write without deadlock; both sets of rows are present', async () => {
    const { dir, dbPath } = tempDbPath();
    try {
      const { parsed, stdout, stderr } = await runScript(`
        const db1 = new Database(${JSON.stringify(dbPath)});
        db1.pragma('journal_mode = WAL');
        db1.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const db2 = new Database(${JSON.stringify(dbPath)});
        db2.pragma('journal_mode = WAL');
        const s1 = sink.createMetricsSink(db1);
        const s2 = sink.createMetricsSink(db2);
        // Interleave writes. better-sqlite3 is synchronous; this is a
        // sanity check that two independent handles on the same file
        // coexist under WAL.
        for (let i = 0; i < 50; i++) {
          (i % 2 === 0 ? s1 : s2).record({
            sessionId: 'S',
            agentId: 'quantitative-expert',
            eventType: 'tool_call',
            path: 'tool_use',
            queriesEmitted: i,
          });
        }
        const n = db1.prepare('SELECT COUNT(*) AS c FROM search_metrics').get().c;
        process.stdout.write(JSON.stringify({ ok: true, n }));
        db1.close(); db2.close();
      `);
      assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
      assert.equal(parsed.n, 50);
    } finally {
      cleanup(dir);
    }
  });
});

describe('search-metrics: tier derivation', () => {
  test('known agents map to correct tiers; unknown → D', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const cases = {
        'research-scout': sink.tierForAgent('research-scout'),
        'red-teamer': sink.tierForAgent('red-teamer'),
        'specialist-legal': sink.tierForAgent('specialist-legal'),
        'process-architect': sink.tierForAgent('process-architect'),
        'unknown-agent-id': sink.tierForAgent('unknown-agent-id'),
      };
      process.stdout.write(JSON.stringify({ ok: true, cases }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.cases['research-scout'], 'A');
    assert.equal(parsed.cases['red-teamer'], 'B');
    assert.equal(parsed.cases['specialist-legal'], 'C');
    assert.equal(parsed.cases['process-architect'], 'D');
    assert.equal(parsed.cases['unknown-agent-id'], 'D');
  });
});
