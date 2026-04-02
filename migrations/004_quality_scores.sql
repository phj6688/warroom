-- Migration 004: Quality scores table
CREATE TABLE IF NOT EXISTS quality_scores (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  phase_completion_rate REAL NOT NULL,
  escalation_efficiency REAL NOT NULL,
  synthesis_structure_score REAL NOT NULL,
  cross_ref_count INTEGER NOT NULL DEFAULT 0,
  shadow_delta REAL,
  composite_score REAL NOT NULL,
  evaluator_model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
