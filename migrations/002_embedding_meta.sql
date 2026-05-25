-- Metadata table for session_embeddings (the vec0 virtual table only
-- stores rowid + vector). This must exist before migration 010 creates
-- the cascade trigger that references it, and before migration 013's
-- ALTER ... RENAME, which re-validates every trigger body and would
-- otherwise fail with "no such table: main.embedding_meta".
CREATE TABLE IF NOT EXISTS embedding_meta (
  rowid INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
