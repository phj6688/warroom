// F11 — durable background jobs over a SQLite table.
//
// This is intentionally NOT a queue library. It's a 5-method module:
//   enqueue(type, payload)        insert a pending row
//   register(type, handler)       map a type → async handler
//   runWorker(opts)               start a setInterval that drains jobs
//   stopWorker(handle)            stop a running worker (also `stop`)
//   getJob(id, opts)              read a row (used by tests + ops)
//
// Failure model: a thrown handler is caught, attempts++, last_error stored,
// and if attempts < maxAttempts the row is rescheduled with exponential
// backoff (2^attempts seconds). At >=maxAttempts the row flips to 'failed'.
// The worker NEVER lets a handler exception propagate to the interval, so
// one bad job cannot crash the loop.
//
// dbPath plumbing exists so tests can isolate to a temp file. The default
// path is the project's canonical DB and is loaded lazily so importing this
// module in a test that supplies its own dbPath does not also touch prod.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const { log } = require('./logger');

const DEFAULT_DB_PATH = process.env.WAR_ROOM_DB_PATH
  ? path.resolve(process.env.WAR_ROOM_DB_PATH)
  : path.join(__dirname, '..', 'data', 'warroom.db');

const DEFAULT_INTERVAL_MS = parseInt(process.env.JOB_WORKER_INTERVAL_MS || '5000', 10);
const DEFAULT_MAX_ATTEMPTS = parseInt(process.env.JOB_MAX_ATTEMPTS || '5', 10);
const BATCH_SIZE = 10;

const handlers = new Map();

// Per-dbPath connection cache so a test that enqueues + runs the worker
// against the same temp DB shares one open file handle.
const connections = new Map();
function getConn(dbPath) {
  const resolved = path.resolve(dbPath || DEFAULT_DB_PATH);
  let conn = connections.get(resolved);
  if (!conn) {
    conn = new Database(resolved);
    conn.pragma('journal_mode = WAL');
    connections.set(resolved, conn);
  }
  return conn;
}

function register(type, handler) {
  if (typeof type !== 'string' || !type) throw new Error('register: type must be a non-empty string');
  if (typeof handler !== 'function') throw new Error('register: handler must be a function');
  handlers.set(type, handler);
}

function enqueue(type, payload, opts = {}) {
  const conn = getConn(opts.dbPath);
  const id = crypto.randomUUID();
  const now = Date.now();
  conn.prepare(
    'INSERT INTO background_jobs (id, type, payload, status, attempts, created_at, updated_at, scheduled_for) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  ).run(id, type, JSON.stringify(payload ?? null), 'pending', now, now, now);
  return id;
}

function getJob(id, opts = {}) {
  return getConn(opts.dbPath).prepare('SELECT * FROM background_jobs WHERE id = ?').get(id);
}

async function processOne(conn, row, maxAttempts) {
  const handler = handlers.get(row.type);
  const now = Date.now();

  // No handler registered → leave the row pending so a later boot can pick
  // it up. We do NOT count this as an attempt.
  if (!handler) {
    return;
  }

  conn.prepare("UPDATE background_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(now, row.id);

  let payload;
  try {
    payload = row.payload ? JSON.parse(row.payload) : null;
  } catch (err) {
    const t = Date.now();
    conn.prepare(
      "UPDATE background_jobs SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?"
    ).run(`payload parse error: ${err.message}`, t, row.id);
    return;
  }

  try {
    await handler(payload);
    const t = Date.now();
    conn.prepare(
      "UPDATE background_jobs SET status = 'completed', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE id = ?"
    ).run(t, row.id);
  } catch (err) {
    const attempts = row.attempts + 1;
    const t = Date.now();
    if (attempts >= maxAttempts) {
      conn.prepare(
        "UPDATE background_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?"
      ).run(attempts, String(err && err.message || err), t, row.id);
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s after attempts 1..5.
      const backoffMs = Math.pow(2, attempts - 1) * 1000;
      conn.prepare(
        "UPDATE background_jobs SET status = 'pending', attempts = ?, last_error = ?, updated_at = ?, scheduled_for = ? WHERE id = ?"
      ).run(attempts, String(err && err.message || err), t, t + backoffMs, row.id);
    }
  }
}

async function tick(conn, maxAttempts) {
  const rows = conn.prepare(
    "SELECT * FROM background_jobs WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for ASC LIMIT ?"
  ).all(Date.now(), BATCH_SIZE);

  for (const row of rows) {
    try {
      await processOne(conn, row, maxAttempts);
    } catch (err) {
      // processOne handles its own errors; this catch is the last-resort
      // moat to keep the worker loop alive even if SQLite itself trips.
      log.error({ jobId: row.id, type: row.type, err: err && err.message || err }, 'jobs worker error');
    }
  }
}

function runWorker(opts = {}) {
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const conn = getConn(opts.dbPath);

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(conn, maxAttempts);
    } catch (err) {
      log.error({ err: err && err.message || err }, 'jobs tick error');
    } finally {
      running = false;
    }
  }, intervalMs);
  if (timer.unref) timer.unref();

  // Kick the loop immediately so callers don't wait a full interval for
  // the first job to run.
  Promise.resolve().then(() => tick(conn, maxAttempts)).catch(() => {});

  return { timer, intervalMs, maxAttempts, dbPath: opts.dbPath };
}

async function stopWorker(handle) {
  if (handle && handle.timer) clearInterval(handle.timer);
  // Drain a final tick so jobs queued right before stop don't get stranded
  // mid-iteration. Tests rely on stop() being awaitable.
  if (handle && handle.dbPath !== undefined) {
    try { await tick(getConn(handle.dbPath), handle.maxAttempts || DEFAULT_MAX_ATTEMPTS); } catch {}
  }
}

function _resetForTests() {
  handlers.clear();
  for (const conn of connections.values()) {
    try { conn.close(); } catch {}
  }
  connections.clear();
}

module.exports = {
  enqueue,
  register,
  runWorker,
  stopWorker,
  stop: stopWorker,
  getJob,
  _resetForTests,
};
