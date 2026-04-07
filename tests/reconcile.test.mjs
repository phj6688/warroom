/**
 * F4 — Boot reconciliation for orphaned active sessions.
 *
 * Spec: forge/hardening/TASKSPEC.md §F4
 *
 * Acceptance:
 *   - At server start, query SELECT id FROM sessions WHERE active=1
 *   - Each row is marked active=0 with crash_recovered_at set
 *   - A {type:'crash-recovered'} broadcast lists recovered IDs
 *
 * Strategy: build an isolated temp DB containing the schema + an active row,
 * spawn the server with WAR_ROOM_DB_PATH=<temp file>, then read back via
 * better-sqlite3 (already a dep — no new deps).
 *
 * Red phase: db.js does NOT honor WAR_ROOM_DB_PATH. To avoid corrupting the
 * production DB, this test does NOT touch ./data/warroom.db. Instead the
 * test asserts the contract against its temp file. In red phase, the temp
 * file's row will still be active=1 (because the spawned server bound to
 * the prod DB instead) and the test will fail with a clear message.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { spawnServer, makeTempDir, REPO_ROOT, delay } from './_helpers.mjs';

let temp;
let dbPath;
let server;

const ORPHAN_ID = 'reconcile-test-orphan-' + Date.now().toString(36);
const ORPHAN_PROBLEM = 'an orphaned session left active=1 by a crash';

before(async () => {
  temp = makeTempDir('warroom-reconcile-');
  dbPath = path.join(temp.dir, 'warroom.db');

  // Build a minimal schema in the temp DB by replaying the project's
  // initial migration. We do NOT replay every migration — we only need
  // the `sessions` table for this test.
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const initialSql = fs.readFileSync(
    path.join(REPO_ROOT, 'migrations', '001_initial.sql'),
    'utf-8'
  );
  db.exec(initialSql);

  // Add the column F4 will introduce; if it already exists from a future
  // migration we silently continue.
  try {
    db.exec('ALTER TABLE sessions ADD COLUMN crash_recovered_at INTEGER');
  } catch { /* already there */ }

  // Insert the orphaned active session.
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)'
  ).run(ORPHAN_ID, ORPHAN_PROBLEM, now, now);

  db.close();

  // Spawn the server pointed at the temp DB. The env var here is the
  // proposed contract — db.js will honor it after F4/F8 land.
  server = await spawnServer({
    env: {
      WAR_ROOM_TOKEN: '',
      WAR_ROOM_DB_PATH: dbPath,
    },
  });
});

after(async () => {
  await server?.dispose();
  temp?.cleanup();
});

describe('F4 — boot reconciliation', () => {
  test('orphaned active session is marked crashed at boot', () => {
    // Re-open the temp DB read-only.
    const db = new Database(dbPath, { readonly: true });
    let row;
    try {
      row = db.prepare('SELECT id, active, crash_recovered_at FROM sessions WHERE id = ?').get(ORPHAN_ID);
    } finally {
      db.close();
    }
    assert.ok(row, `orphaned row must exist (sanity); test DB at ${dbPath}`);
    assert.equal(row.active, 0, 'orphaned session must be marked active=0 after boot reconciliation');
    assert.ok(
      row.crash_recovered_at && Number(row.crash_recovered_at) > 0,
      'crash_recovered_at must be a non-zero timestamp'
    );
  });

  test('boot logs include a crash-recovered notice with the orphan ID', () => {
    const combined = server.logs.join('');
    assert.ok(
      combined.includes(ORPHAN_ID) || /crash[- ]recovered/i.test(combined),
      `expected boot log to mention crash recovery; got tail: ${combined.slice(-500)}`
    );
  });

  test('reconciliation does not delete the row, only marks it crashed', () => {
    const db = new Database(dbPath, { readonly: true });
    let count;
    try {
      count = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE id = ?').get(ORPHAN_ID).c;
    } finally {
      db.close();
    }
    assert.equal(count, 1, 'reconcile must preserve the row, not delete it');
  });

  test('subsequent boot is a no-op for already-recovered rows', async () => {
    // Restart server. The orphan row is now active=0 with crash_recovered_at
    // set; on second boot the reconciler should NOT touch it again.
    await server.dispose();
    const db1 = new Database(dbPath, { readonly: true });
    const before = db1.prepare('SELECT crash_recovered_at FROM sessions WHERE id = ?').get(ORPHAN_ID);
    db1.close();

    server = await spawnServer({
      env: { WAR_ROOM_TOKEN: '', WAR_ROOM_DB_PATH: dbPath },
    });

    const db2 = new Database(dbPath, { readonly: true });
    const after = db2.prepare('SELECT crash_recovered_at FROM sessions WHERE id = ?').get(ORPHAN_ID);
    db2.close();

    assert.equal(
      after.crash_recovered_at,
      before.crash_recovered_at,
      'crash_recovered_at must not be overwritten on subsequent boots'
    );
  });
});
