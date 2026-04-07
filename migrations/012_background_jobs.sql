-- F11 — Background job table replaces fire-and-forget post-deliberation work.
--
-- Pre-S3, runDeliberation kicked off memory.storeSessionMemory,
-- memory.extractArchivalFacts and quality.evaluateSession with bare .catch
-- handlers. A crash mid-call dropped the work on the floor and there was no
-- retry. This table is the durable queue: rows live across restarts and the
-- in-process worker (lib/jobs.js) drains them with exponential backoff.
--
-- scheduled_for is the earliest time the worker should consider a row.
-- Pending + ready jobs are picked via (status='pending' AND scheduled_for<=now)
-- so the index covers both the status filter and the time predicate.
CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL
);

CREATE INDEX idx_background_jobs_status_scheduled
  ON background_jobs(status, scheduled_for);
