/**
 * HLB-152 R4 — DB schema + write/read path for per-session token accounting.
 *
 * Migration 018 adds `total_tokens` (INTEGER) and `token_breakdown` (TEXT JSON)
 * to the sessions table. This file asserts:
 *   - the columns exist after migrate, are nullable, and have the expected
 *     declared types;
 *   - the migration is idempotent — running the runner twice over the same DB
 *     does not error and does not double-apply;
 *   - rows that pre-date the migration backfill to NULL (no error), and a
 *     persisted total + breakdown round-trips;
 *   - enrichSession (the /api/sessions payload builder) surfaces totalTokens
 *     and tokenBreakdown on the session object.
 *
 * Per repo convention this .test.mjs uses the migration runner and better-
 * sqlite3 directly (the same pattern as session-continuation.test.mjs's
 * migration block) but does not import server.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runMigrations } = require(path.join(root, 'lib', 'migrations.js'));
const { enrichSession } = require(path.join(root, 'lib', 'routes.js'));
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));

function freshDb() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-tok-')), 'c.db');
  runMigrations({ dbPath, migrationsDir: path.join(root, 'migrations') });
  return { dbPath, db: new Database(dbPath) };
}

describe('migration 018: token accounting columns', () => {
  test('adds nullable total_tokens (INTEGER) and token_breakdown (TEXT)', () => {
    const { db } = freshDb();
    const cols = db.prepare('PRAGMA table_info(sessions)').all();

    const total = cols.find(c => c.name === 'total_tokens');
    assert.ok(total, 'total_tokens column exists');
    assert.match(total.type, /INT/i, 'total_tokens is an INTEGER-affinity column');
    assert.equal(total.notnull, 0, 'total_tokens is nullable');

    const breakdown = cols.find(c => c.name === 'token_breakdown');
    assert.ok(breakdown, 'token_breakdown column exists');
    assert.match(breakdown.type, /TEXT/i, 'token_breakdown is a TEXT column');
    assert.equal(breakdown.notnull, 0, 'token_breakdown is nullable');
    db.close();
  });

  test('is idempotent: running migrations twice is safe and does not re-apply', () => {
    const { dbPath, db } = freshDb();
    db.close();
    // Second run over the same DB. Must not throw (checksum stable) and must
    // not insert a duplicate schema_version row for 018.
    runMigrations({ dbPath, migrationsDir: path.join(root, 'migrations') });
    const db2 = new Database(dbPath);
    const rows = db2.prepare('SELECT COUNT(*) AS c FROM schema_version WHERE version = 18').get();
    assert.equal(rows.c, 1, 'exactly one schema_version row for migration 018');
    // Columns still present and singular (no duplicate-column error surfaced).
    const cols = db2.prepare('PRAGMA table_info(sessions)').all();
    assert.equal(cols.filter(c => c.name === 'total_tokens').length, 1);
    assert.equal(cols.filter(c => c.name === 'token_breakdown').length, 1);
    db2.close();
  });

  test('rows created before the columns backfill to NULL and a total round-trips', () => {
    // Simulate a pre-migration row by migrating only up to 017, inserting, then
    // applying the full set (which includes 018). The new columns must land as
    // NULL on the existing row without error.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-tok-bf-'));
    const dbPath = path.join(tmp, 'c.db');
    const fullMigDir = path.join(root, 'migrations');

    // Stage a migrations dir containing only files <= 017.
    const partialDir = path.join(tmp, 'migrations-partial');
    fs.mkdirSync(partialDir);
    for (const f of fs.readdirSync(fullMigDir)) {
      const n = parseInt(f.split('_')[0], 10);
      if (Number.isFinite(n) && n <= 17 && /\.sql$/.test(f)) {
        fs.copyFileSync(path.join(fullMigDir, f), path.join(partialDir, f));
      }
    }
    runMigrations({ dbPath, migrationsDir: partialDir });

    const pre = new Database(dbPath);
    const now = Date.now();
    pre.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?,?,0,0,?,?)')
      .run('old', 'legacy problem', now, now);
    pre.close();

    // Now apply the full set, which adds 018.
    runMigrations({ dbPath, migrationsDir: fullMigDir });
    const db = new Database(dbPath);

    const legacy = db.prepare('SELECT total_tokens, token_breakdown FROM sessions WHERE id = ?').get('old');
    assert.equal(legacy.total_tokens, null, 'pre-existing row backfills total_tokens to NULL');
    assert.equal(legacy.token_breakdown, null, 'pre-existing row backfills token_breakdown to NULL');

    // A fresh write round-trips.
    const breakdown = JSON.stringify({ agent_turn: { input_tokens: 10, output_tokens: 5, total_tokens: 15, calls: 1 } });
    db.prepare('UPDATE sessions SET total_tokens = ?, token_breakdown = ?, updated_at = ? WHERE id = ?')
      .run(15, breakdown, Date.now(), 'old');
    const after = db.prepare('SELECT total_tokens, token_breakdown FROM sessions WHERE id = ?').get('old');
    assert.equal(after.total_tokens, 15);
    assert.deepEqual(JSON.parse(after.token_breakdown), JSON.parse(breakdown));
    db.close();
  });
});

describe('session payload: token fields surfaced', () => {
  test('enrichSession exposes totalTokens and parsed tokenBreakdown', () => {
    const breakdown = { agent_turn: { input_tokens: 100, output_tokens: 40, total_tokens: 140, calls: 2 } };
    const row = {
      id: 's1', problem: 'p', phase: 4, active: 0,
      created_at: 1, updated_at: 2,
      total_tokens: 140,
      token_breakdown: JSON.stringify(breakdown),
      message_count: 3, escalation_count: 0,
    };
    const payload = enrichSession(row, {});
    assert.equal(payload.totalTokens, 140, 'totalTokens surfaced on the payload');
    assert.deepEqual(payload.tokenBreakdown, breakdown, 'tokenBreakdown parsed from JSON');
  });

  test('a session with no token data surfaces null/zero without throwing', () => {
    const row = {
      id: 's2', problem: 'p', phase: 0, active: 1,
      created_at: 1, updated_at: 2,
      total_tokens: null, token_breakdown: null,
      message_count: 0, escalation_count: 0,
    };
    const payload = enrichSession(row, {});
    assert.equal(payload.totalTokens, null);
    assert.equal(payload.tokenBreakdown, null);
  });
});

describe('write/read path: persistSessionTokens (R4)', () => {
  // server.js cannot be required in-process (binds a listener on require), so
  // we exercise the persistence helper exported from lib/token-usage.js against
  // a real migrated DB, mirroring exactly what the deliberation-complete path
  // does: snapshot the ledger, write total_tokens + token_breakdown, read back.
  test('snapshot is persisted to the sessions row and reads back intact', () => {
    const { db } = freshDb();
    const { createTokenLedger, persistSessionTokens } = require(path.join(root, 'lib', 'token-usage.js'));
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?,?,0,1,?,?)')
      .run('live', 'a real problem statement here', now, now);

    const ledger = createTokenLedger();
    ledger.add('live', 'agent_turn', { input_tokens: 500, output_tokens: 200 });
    ledger.add('live', 'tool_call', { prompt_tokens: 300, completion_tokens: 100, total_tokens: 400 });
    ledger.add('live', 'quality', { input_tokens: 50, output_tokens: 10 });
    ledger.add('live', 'embedding', { input_tokens: 40, output_tokens: 0 }, { estimated: true });

    const snap = persistSessionTokens(db, 'live', ledger);
    assert.ok(snap.total_tokens > 0);

    const row = db.prepare('SELECT total_tokens, token_breakdown FROM sessions WHERE id = ?').get('live');
    assert.equal(row.total_tokens, snap.total_tokens);
    const bd = JSON.parse(row.token_breakdown);
    assert.equal(bd.agent_turn.total_tokens, 700);
    assert.equal(bd.tool_call.total_tokens, 400);
    assert.equal(bd.quality.total_tokens, 60);
    assert.equal(bd.embedding.total_tokens, 40);
    assert.equal(bd.embedding.estimated, 40);
    assert.equal(row.total_tokens, 700 + 400 + 60 + 40);
    db.close();
  });
});
