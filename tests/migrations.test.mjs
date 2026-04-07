/**
 * F8 — Migration runner: transactions + checksums.
 *
 * Spec: forge/hardening/TASKSPEC.md §F8
 *
 * Acceptance:
 *   - runMigrations() wraps each file in db.transaction(...)
 *   - schema_version gains `name TEXT` and `checksum TEXT` columns
 *   - On boot, if a previously-applied file's checksum no longer matches,
 *     server fails to start with a clear error
 *   - Half-applied migration is impossible: a SQL error inside the file
 *     rolls back the version row insert too.
 *
 * Strategy: spawn a child node script that imports the runner from a file
 * F8 will deliver (`lib/migrations.js` or similar). The script points the
 * runner at a temp DB and a temp migrations dir we control. Reports JSON.
 *
 * Red phase: the runner is currently inline in db.js (no transaction,
 * no checksums) and is not exported. The require() in the child script
 * will fail and the test will surface that.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runNodeScript, makeTempDir, REPO_ROOT } from './_helpers.mjs';

// Possible locations for the extracted runner. The script tries each in order.
const RUNNER_CANDIDATES = [
  path.join(REPO_ROOT, 'lib', 'migrations.js'),
  path.join(REPO_ROOT, 'lib', 'migrate.js'),
];

let temp;

before(() => {
  temp = makeTempDir('warroom-mig-');
});

after(() => {
  temp?.cleanup();
});

// Returns a snippet that resolves runMigrations or sets BAIL=true with the
// failure JSON already on stdout. Caller must check BAIL before continuing.
function runnerLoaderSnippet() {
  return `
    let runMigrations = null;
    let BAIL = false;
    {
      const candidates = ${JSON.stringify(RUNNER_CANDIDATES)};
      let runner = null;
      let lastErr = null;
      for (const c of candidates) {
        try { runner = require(c); break; }
        catch (err) {
          lastErr = err;
          if (err.code !== 'MODULE_NOT_FOUND') {
            process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message, file: c }));
            process.exitCode = 1;
            BAIL = true;
            break;
          }
        }
      }
      if (!BAIL && !runner) {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: 'no migration runner module found', tried: candidates, lastErr: lastErr && lastErr.message }));
        process.exitCode = 1;
        BAIL = true;
      }
      if (!BAIL) {
        runMigrations = runner.runMigrations;
        if (typeof runMigrations !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'export', error: 'runMigrations export missing' }));
          process.exitCode = 1;
          BAIL = true;
        }
      }
    }
  `;
}

describe('F8 — migration runner txn + checksums', () => {
  test('failing migration rolls back: schema_version row not inserted, table not created', async () => {
    const dbPath = path.join(temp.dir, 'fail.db');
    const migDir = path.join(temp.dir, 'fail-migrations');
    fs.mkdirSync(migDir, { recursive: true });

    // A bogus migration that creates `foo` then deliberately syntax-errors.
    fs.writeFileSync(
      path.join(migDir, '900_bad.sql'),
      `CREATE TABLE foo (id INTEGER PRIMARY KEY);\nINTENTIONAL_SYNTAX_ERROR_HERE;\n`
    );

    const script = `
      'use strict';
      const Database = require('better-sqlite3');
      ${runnerLoaderSnippet()}

      if (!BAIL) {
        const dbPath = ${JSON.stringify(dbPath)};
        const migDir = ${JSON.stringify(migDir)};

        let threw = false;
        let errMsg = null;
        try {
          runMigrations({ dbPath, migrationsDir: migDir });
        } catch (err) {
          threw = true;
          errMsg = err.message;
        }

        const db = new Database(dbPath, { readonly: false });
        const fooExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='foo'").get();
        let versionRow = null;
        try {
          // .get() returns undefined for "no row"; coerce to null so JSON
          // serialization preserves the field across the IPC boundary.
          versionRow = db.prepare("SELECT * FROM schema_version WHERE version=900").get() || null;
        } catch (e) { /* table may not even exist */ }
        db.close();

        process.stdout.write(JSON.stringify({
          ok: true,
          threw,
          errMsg,
          fooExists: !!fooExists,
          versionRow,
        }));
      }
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 20_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.equal(parsed.threw, true, 'failing migration must throw');
    assert.equal(parsed.fooExists, false, 'foo table must NOT exist (rolled back)');
    assert.equal(parsed.versionRow, null, 'schema_version row 900 must NOT be inserted');
  });

  test('checksum mismatch on previously-applied migration → boot fails with clear error', async () => {
    const dbPath = path.join(temp.dir, 'checksum.db');
    const migDir = path.join(temp.dir, 'checksum-migrations');
    fs.mkdirSync(migDir, { recursive: true });

    // First version of the migration.
    const migFile = path.join(migDir, '901_first.sql');
    fs.writeFileSync(migFile, `CREATE TABLE bar (id INTEGER PRIMARY KEY, name TEXT);\n`);

    const script1 = `
      'use strict';
      ${runnerLoaderSnippet()}
      if (!BAIL) {
        try {
          runMigrations({ dbPath: ${JSON.stringify(dbPath)}, migrationsDir: ${JSON.stringify(migDir)} });
          process.stdout.write(JSON.stringify({ ok: true, stage: 'first-run' }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'first-run', error: err.message }));
          process.exitCode = 2;
        }
      }
    `;
    const r1 = await runNodeScript(script1, { timeoutMs: 20_000 });
    let p1 = null;
    try { p1 = JSON.parse(r1.stdout); } catch {}
    assert.ok(p1 && p1.ok, `first-run failed (code=${r1.code}).\nstdout=${r1.stdout}\nstderr=${r1.stderr}`);

    // Now mutate the migration file content. Same version number, different SQL.
    fs.writeFileSync(migFile, `CREATE TABLE bar (id INTEGER PRIMARY KEY, name TEXT, EXTRA TEXT);\n`);

    const script2 = `
      'use strict';
      ${runnerLoaderSnippet()}
      if (!BAIL) {
        let threw = false;
        let errMsg = null;
        try {
          runMigrations({ dbPath: ${JSON.stringify(dbPath)}, migrationsDir: ${JSON.stringify(migDir)} });
        } catch (err) {
          threw = true;
          errMsg = err.message;
        }
        process.stdout.write(JSON.stringify({ ok: true, threw, errMsg }));
      }
    `;
    const r2 = await runNodeScript(script2, { timeoutMs: 20_000 });
    let p2 = null;
    try { p2 = JSON.parse(r2.stdout); } catch {}

    assert.ok(p2 && p2.ok, `second-run runner failed (code=${r2.code}).\nstdout=${r2.stdout}\nstderr=${r2.stderr}`);
    assert.equal(p2.threw, true, 'second run with mutated content must throw');
    assert.match(p2.errMsg || '', /checksum/i, 'error message must mention checksum');
  });

  test('successful migration: schema_version row stores version, name, checksum', async () => {
    const dbPath = path.join(temp.dir, 'happy.db');
    const migDir = path.join(temp.dir, 'happy-migrations');
    fs.mkdirSync(migDir, { recursive: true });

    fs.writeFileSync(
      path.join(migDir, '902_happy.sql'),
      `CREATE TABLE happy (id INTEGER PRIMARY KEY);\n`
    );

    const script = `
      'use strict';
      const Database = require('better-sqlite3');
      ${runnerLoaderSnippet()}
      if (!BAIL) {
        try {
          runMigrations({ dbPath: ${JSON.stringify(dbPath)}, migrationsDir: ${JSON.stringify(migDir)} });
          const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
          const row = db.prepare("SELECT version, name, checksum FROM schema_version WHERE version=902").get();
          db.close();
          process.stdout.write(JSON.stringify({ ok: true, row }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'happy', error: err.message }));
          process.exitCode = 2;
        }
      }
    `;
    const r = await runNodeScript(script, { timeoutMs: 20_000 });
    let p = null;
    try { p = JSON.parse(r.stdout); } catch {}

    assert.ok(p && p.ok, `happy-path runner failed (code=${r.code}).\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(p.row, 'schema_version row must be inserted');
    assert.equal(p.row.version, 902);
    assert.ok(p.row.name && p.row.name.includes('happy'), 'name column must record migration filename');
    assert.ok(p.row.checksum && p.row.checksum.length > 0, 'checksum column must be populated');
  });
});
