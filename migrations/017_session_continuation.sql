-- Migration 017: session continuation link
ALTER TABLE sessions ADD COLUMN continues_from_session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_continues_from ON sessions(continues_from_session_id);
