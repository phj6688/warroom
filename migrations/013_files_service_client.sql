-- Migration 013: Rewrite session_files for files-service client.
-- Renames the legacy table (which held inline content) and creates a new
-- session_files that stores only file_id references + denormalized metadata.
-- Data migration (HTTP round-trips to files-service) happens in JS after
-- the DDL runs.

ALTER TABLE session_files RENAME TO session_files_legacy;

CREATE TABLE session_files (
  session_id      TEXT NOT NULL,
  file_id         TEXT NOT NULL,
  file_sha256     TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_tokens     INTEGER NOT NULL,
  file_mime       TEXT NOT NULL,
  attached_at     INTEGER NOT NULL,
  PRIMARY KEY (session_id, file_id)
);

CREATE INDEX idx_session_files_session_v2 ON session_files(session_id);
