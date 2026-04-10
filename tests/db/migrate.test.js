const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Stub logger
vi.mock('../../lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { runLegacyFileMigration } = require('../../lib/migrate-files');

function createTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-migrate-test-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return { db, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function setupLegacySchema(db) {
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, problem TEXT, phase INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE session_files_legacy (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER,
      type TEXT,
      content TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE session_files (
      session_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_sha256 TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_tokens INTEGER NOT NULL,
      file_mime TEXT NOT NULL,
      attached_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, file_id)
    );
  `);
}

function insertLegacyRows(db, rows) {
  const stmt = db.prepare('INSERT INTO session_files_legacy (id, session_id, name, size, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const r of rows) {
    stmt.run(r.id, r.session_id, r.name, r.size || 0, r.type || 'text/plain', r.content || 'file content', r.created_at || Date.now());
  }
}

function stubFilesClient({ failOnId } = {}) {
  let callCount = 0;
  return {
    health: vi.fn(async () => ({ status: 'ok' })),
    uploadFiles: vi.fn(async (files) => {
      callCount++;
      const f = files[0];
      if (failOnId && callCount === failOnId) {
        throw new Error('upload failed');
      }
      return {
        files: [{
          id: `fs-${callCount}`,
          sha256: `sha256-${callCount}`,
          name: f.name,
          tokens: 100,
          mime: f.mime,
        }],
      };
    }),
  };
}

describe('legacy file migration', () => {
  let testDb;

  afterEach(() => {
    if (testDb) {
      testDb.db.close();
      testDb.cleanup();
    }
  });

  it('no legacy table → no-op', async () => {
    testDb = createTestDb();
    // No legacy table at all
    const summary = await runLegacyFileMigration(testDb.db, stubFilesClient());
    expect(summary).toEqual({ total: 0, migrated: 0, failed: 0 });
  });

  it('legacy table with 3 rows → all migrated, legacy dropped', async () => {
    testDb = createTestDb();
    setupLegacySchema(testDb.db);
    testDb.db.exec("INSERT INTO sessions (id, problem, created_at, updated_at) VALUES ('s1', 'test', 1000, 1000)");
    insertLegacyRows(testDb.db, [
      { id: 'f1', session_id: 's1', name: 'a.txt', content: 'aaa' },
      { id: 'f2', session_id: 's1', name: 'b.txt', content: 'bbb' },
      { id: 'f3', session_id: 's1', name: 'c.txt', content: 'ccc' },
    ]);

    const client = stubFilesClient();
    const summary = await runLegacyFileMigration(testDb.db, client);
    expect(summary).toEqual({ total: 3, migrated: 3, failed: 0 });
    expect(client.uploadFiles).toHaveBeenCalledTimes(3);

    // New rows exist
    const newRows = testDb.db.prepare('SELECT * FROM session_files').all();
    expect(newRows).toHaveLength(3);

    // Legacy table dropped
    const legacy = testDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_files_legacy'").get();
    expect(legacy).toBeUndefined();
  });

  it('upload failure on row 2 → 1 migrated, 2 remain in legacy', async () => {
    testDb = createTestDb();
    setupLegacySchema(testDb.db);
    testDb.db.exec("INSERT INTO sessions (id, problem, created_at, updated_at) VALUES ('s1', 'test', 1000, 1000)");
    insertLegacyRows(testDb.db, [
      { id: 'f1', session_id: 's1', name: 'a.txt', content: 'aaa' },
      { id: 'f2', session_id: 's1', name: 'b.txt', content: 'bbb' },
      { id: 'f3', session_id: 's1', name: 'c.txt', content: 'ccc' },
    ]);

    const client = stubFilesClient({ failOnId: 2 });
    const summary = await runLegacyFileMigration(testDb.db, client);
    expect(summary.migrated).toBe(2);
    expect(summary.failed).toBe(1);

    // Legacy table still exists with remaining rows
    const remaining = testDb.db.prepare('SELECT COUNT(*) as n FROM session_files_legacy').get().n;
    expect(remaining).toBe(1);
  });

  it('running twice is safe (idempotent)', async () => {
    testDb = createTestDb();
    setupLegacySchema(testDb.db);
    testDb.db.exec("INSERT INTO sessions (id, problem, created_at, updated_at) VALUES ('s1', 'test', 1000, 1000)");
    insertLegacyRows(testDb.db, [
      { id: 'f1', session_id: 's1', name: 'a.txt', content: 'aaa' },
    ]);

    const client = stubFilesClient();
    await runLegacyFileMigration(testDb.db, client);

    // Run again — should be a no-op (legacy table dropped)
    const summary2 = await runLegacyFileMigration(testDb.db, client);
    expect(summary2).toEqual({ total: 0, migrated: 0, failed: 0 });
  });

  it('empty legacy table is dropped immediately', async () => {
    testDb = createTestDb();
    setupLegacySchema(testDb.db);

    const summary = await runLegacyFileMigration(testDb.db, stubFilesClient());
    expect(summary).toEqual({ total: 0, migrated: 0, failed: 0 });

    const legacy = testDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_files_legacy'").get();
    expect(legacy).toBeUndefined();
  });
});
