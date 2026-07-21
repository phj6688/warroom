// B7 (HLB-797) — migration 021 adds the additive nullable columns
// sessions.outcome and sessions.failed_at. Applies the real migration set to a
// fresh temp DB through the runner and asserts the columns exist. Driven via a
// child script (project convention: no test imports lib/* in-process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { runMigrations } = require('./lib/migrations.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mig021-'));
const dbPath = path.join(dir, 'test.db');
runMigrations({ dbPath, migrationsDir: path.join(process.cwd(), 'migrations') });

const db = new Database(dbPath);
const cols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
const outcomeCol = db.prepare("SELECT type FROM pragma_table_info('sessions') WHERE name = 'outcome'").get();
const failedAtCol = db.prepare("SELECT type FROM pragma_table_info('sessions') WHERE name = 'failed_at'").get();
db.close();
fs.rmSync(dir, { recursive: true, force: true });

assert.ok(cols.includes('outcome'), 'sessions.outcome exists after migration 021');
assert.ok(cols.includes('failed_at'), 'sessions.failed_at exists after migration 021');
assert.equal(outcomeCol && outcomeCol.type, 'TEXT', 'outcome is TEXT');
assert.equal(failedAtCol && failedAtCol.type, 'INTEGER', 'failed_at is INTEGER');
console.log('migration-021 assertions passed');
`;

test('migration 021 adds sessions.outcome and sessions.failed_at (HLB-797)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /migration-021 assertions passed/);
});
