-- Migration 006: Add shadow_answer column to sessions
ALTER TABLE sessions ADD COLUMN shadow_answer TEXT;
