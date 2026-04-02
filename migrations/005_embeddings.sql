-- Migration 005: Session embeddings (sqlite-vec) + session columns

ALTER TABLE sessions ADD COLUMN quality_score REAL;
ALTER TABLE sessions ADD COLUMN memory_injected INTEGER DEFAULT 0;
