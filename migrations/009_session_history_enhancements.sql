-- Session History Enhancements: pin support + indexes
ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_sessions_archetype ON sessions(archetype_id);
CREATE INDEX IF NOT EXISTS idx_sessions_quality ON sessions(quality_score);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(pinned);
