/**
 * F11 — Background job table replaces fire-and-forget.
 *
 * Spec: forge/hardening/TASKSPEC.md §F11
 *
 * Acceptance:
 *   - migrations/011_background_jobs.sql creates background_jobs table
 *   - lib/jobs.js exports enqueue(type, payload), runWorker(), register(type, handler)
 *   - Failed jobs retry with exponential backoff up to 5 attempts
 *   - tests/jobs.test.mjs: enqueue a flaky job that fails twice then succeeds;
 *     assert attempts=3, status='completed'
 *
 * In red phase: lib/jobs.js does not exist. The child-process script will
 * fail with MODULE_NOT_FOUND and the test will report that.
 *
 * NOTE: per the constraint "no test file imports lib/* directly", this test
 * runs an inline node script via child_process. The script does the import
 * and reports back via stdout JSON. The test parses stdout.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runNodeScript, makeTempDir, REPO_ROOT } from './_helpers.mjs';

let temp;
let dbPath;

before(() => {
  temp = makeTempDir('warroom-jobs-');
  dbPath = path.join(temp.dir, 'jobs.db');

  // Build the schema F11 will deliver. We replay the migration file if it
  // exists; otherwise we create the table inline so the worker has somewhere
  // to write. (Red phase: 011_background_jobs.sql doesn't exist yet — that
  // is the failure mode the test is designed to surface.)
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const migrationPath = path.join(REPO_ROOT, 'migrations', '011_background_jobs.sql');
  if (fs.existsSync(migrationPath)) {
    db.exec(fs.readFileSync(migrationPath, 'utf-8'));
  } else {
    // Conservative scaffold matching the spec's column list.
    db.exec(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        scheduled_for INTEGER
      );
    `);
  }
  db.close();
});

after(() => {
  temp?.cleanup();
});

describe('F11 — background job worker', () => {
  test('flaky handler that fails twice then succeeds → attempts=3, status=completed', async () => {
    // Inline script run in a child process so the .test.mjs file itself
    // never imports lib/jobs.js (per spec constraint).
    const script = `
      'use strict';
      const Database = require('better-sqlite3');
      const dbPath = ${JSON.stringify(dbPath)};
      const jobsPath = ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'jobs.js'))};

      (async () => {
        let jobs;
        try {
          jobs = require(jobsPath);
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message }));
          process.exitCode = 1;
          return;
        }

        const { enqueue, runWorker, register, stop } = jobs;
        let attempts = 0;
        register('flaky', async (payload) => {
          attempts += 1;
          if (attempts < 3) throw new Error('synthetic failure ' + attempts);
          return { ok: true, payload };
        });

        try {
          await enqueue('flaky', { hello: 'world' }, { dbPath });
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'enqueue', error: err.message }));
          process.exitCode = 2;
          return;
        }

        const workerHandle = runWorker({ dbPath, intervalMs: 100 });

        const deadline = Date.now() + 30_000;
        let row = null;
        while (Date.now() < deadline) {
          const db = new Database(dbPath, { readonly: true });
          row = db.prepare("SELECT id, type, attempts, status FROM background_jobs WHERE type='flaky' ORDER BY created_at DESC LIMIT 1").get();
          db.close();
          if (row && (row.status === 'completed' || row.status === 'failed')) break;
          await new Promise(r => setTimeout(r, 100));
        }

        if (typeof stop === 'function') await stop(workerHandle);
        process.stdout.write(JSON.stringify({ ok: true, row }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 45_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}). stdout=${stdout}\nstderr=${stderr}`
    );
    assert.ok(parsed.row, 'job row must exist after worker run');
    assert.equal(parsed.row.status, 'completed', 'job must end as completed');
    assert.equal(parsed.row.attempts, 3, 'job must record exactly 3 attempts');
  });

  test('always-failing handler reaches max attempts and is marked failed', async () => {
    const script = `
      'use strict';
      const Database = require('better-sqlite3');
      const dbPath = ${JSON.stringify(dbPath)};
      const jobsPath = ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'jobs.js'))};

      (async () => {
        let jobs;
        try {
          jobs = require(jobsPath);
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message }));
          process.exitCode = 1;
          return;
        }
        const { enqueue, runWorker, register, stop } = jobs;
        register('always-fail', async () => { throw new Error('boom'); });

        await enqueue('always-fail', {}, { dbPath });
        const handle = runWorker({ dbPath, intervalMs: 50, maxAttempts: 5 });

        const deadline = Date.now() + 30_000;
        let row = null;
        while (Date.now() < deadline) {
          const db = new Database(dbPath, { readonly: true });
          row = db.prepare("SELECT attempts, status, last_error FROM background_jobs WHERE type='always-fail' ORDER BY created_at DESC LIMIT 1").get();
          db.close();
          if (row && row.status === 'failed') break;
          await new Promise(r => setTimeout(r, 100));
        }
        if (typeof stop === 'function') await stop(handle);
        process.stdout.write(JSON.stringify({ ok: true, row }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 45_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}). stdout=${stdout}\nstderr=${stderr}`
    );
    assert.equal(parsed.row?.status, 'failed', 'always-failing job must end as failed');
    assert.equal(parsed.row?.attempts, 5, 'must reach JOB_MAX_ATTEMPTS=5 retries');
    assert.ok(parsed.row?.last_error, 'last_error must be recorded');
  });
});
