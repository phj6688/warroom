-- Migration 007: Problem archetypes
CREATE TABLE IF NOT EXISTS archetypes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  session_count INTEGER DEFAULT 0,
  avg_quality_score REAL,
  recommended_specialists TEXT,
  recommended_phase_config TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_archetypes (
  session_id TEXT NOT NULL,
  archetype_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (session_id, archetype_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (archetype_id) REFERENCES archetypes(id) ON DELETE CASCADE
);

ALTER TABLE sessions ADD COLUMN archetype_id TEXT;
ALTER TABLE sessions ADD COLUMN phase_config TEXT;
ALTER TABLE sessions ADD COLUMN specialist_agents TEXT;
