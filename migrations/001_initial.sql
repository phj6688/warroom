-- Migration 001: Initial schema
-- Recreates the existing War Room database schema

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  phase INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER,
  type TEXT,
  content TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_emoji TEXT,
  agent_color TEXT,
  content TEXT NOT NULL,
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  agent_name TEXT,
  agent_emoji TEXT,
  question TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS human_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);
CREATE INDEX IF NOT EXISTS idx_human_messages_session ON human_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
