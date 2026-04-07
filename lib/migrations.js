// F8 — Migration runner with transactions and checksums.
//
// Pre-S4, db.js ran each migration as `db.exec(sql); insertVersionRow()` —
// two separate statements. Multi-statement migrations could half-apply (the
// first DDL committed, the second errored, the version row never written),
// and there was no checksum so an editor mutating an already-applied .sql
// file produced silent dev/prod drift.
//
// This module wraps each pending migration in a `db.transaction(...)` and
// records a sha256 of the file contents alongside the version. On every
// boot it re-checks the checksum of every previously-applied migration; a
// mismatch is a fatal startup error.
//
// Bootstrap: the schema_version table itself needs `name` + `checksum`
// columns to record those values. The bootstrap step runs BEFORE the
// migration loop, detects whether the columns exist via PRAGMA, and adds
// them inline if not. New databases get the full schema in one CREATE.
// Existing databases (created by the pre-S4 db.js) get an in-place ALTER.
//
// Public API:
//   runMigrations({ db?, dbPath?, migrationsDir, log? })
//   Provide either an open `db` (better-sqlite3 instance) or `dbPath` to
//   open one. The runner closes any DB it opens itself; caller-owned DBs
//   are left open.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIG_FILE_RE = /^\d{3}_.+\.sql$/;

function bootstrapSchemaVersion(db) {
  // Fresh DBs land here with the full column set.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT,
      checksum TEXT,
      applied_at INTEGER
    )
  `);
  // Existing DBs created before S4 only had (version, applied_at). Add the
  // missing columns in place. PRAGMA table_info returns one row per column.
  const cols = db.prepare('PRAGMA table_info(schema_version)').all();
  const have = new Set(cols.map(c => c.name));
  if (!have.has('name')) {
    db.exec('ALTER TABLE schema_version ADD COLUMN name TEXT');
  }
  if (!have.has('checksum')) {
    db.exec('ALTER TABLE schema_version ADD COLUMN checksum TEXT');
  }
}

function checksumOf(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function runMigrations(opts = {}) {
  // Silent by default. The host (db.js) passes console.log explicitly so
  // tests that parse a child process's stdout as JSON do not get migration
  // banners interleaved with their payload.
  const { migrationsDir, log = () => {} } = opts;
  if (!migrationsDir) throw new Error('runMigrations: migrationsDir is required');

  let db = opts.db;
  let ownsDb = false;
  if (!db) {
    if (!opts.dbPath) throw new Error('runMigrations: db or dbPath is required');
    db = new Database(opts.dbPath);
    db.pragma('journal_mode = WAL');
    ownsDb = true;
  }

  try {
    bootstrapSchemaVersion(db);

    if (!fs.existsSync(migrationsDir)) return;

    const appliedRows = db
      .prepare('SELECT version, name, checksum FROM schema_version')
      .all();
    const applied = new Map(appliedRows.map(r => [r.version, r]));

    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => MIG_FILE_RE.test(f))
      .sort();

    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      const fullPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(fullPath, 'utf-8');
      const checksum = checksumOf(sql);

      if (applied.has(version)) {
        const stored = applied.get(version);
        // Backfill: rows applied by the pre-S4 runner have no checksum.
        // Stamp them with the current file's checksum so future drift is
        // detected. This is the chicken-and-egg fix: a freshly-bootstrapped
        // DB or an old DB both end up with checksum coverage after one
        // boot, without forcing the operator to wipe schema_version.
        if (stored.checksum == null) {
          db.prepare('UPDATE schema_version SET name = ?, checksum = ? WHERE version = ?')
            .run(file, checksum, version);
          continue;
        }
        if (stored.checksum !== checksum) {
          throw new Error(
            `Migration ${file} checksum mismatch — file edited after apply ` +
            `(stored=${stored.checksum.slice(0, 12)}, current=${checksum.slice(0, 12)}). ` +
            `Refusing to start.`
          );
        }
        continue;
      }

      // New migration: apply DDL and record the version row in the same
      // transaction so a failure inside the .sql file rolls both back.
      const apply = db.transaction(() => {
        db.exec(sql);
        db.prepare(
          'INSERT INTO schema_version (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
        ).run(version, file, checksum, Date.now());
      });
      apply();
      log(`  Migration ${file} applied`);
    }
  } finally {
    if (ownsDb) {
      try { db.close(); } catch (_) {}
    }
  }
}

module.exports = { runMigrations, bootstrapSchemaVersion, checksumOf };
