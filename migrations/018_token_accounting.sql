-- Migration 018: per-session token accounting (HLB-152).
-- total_tokens is the grand total of every LLM and embedding call in the
-- session; token_breakdown is a JSON object split by purpose (agent turn,
-- tool call, quality, memory, embedding). Both are nullable so rows that
-- pre-date this migration backfill to NULL and are written at completion.
ALTER TABLE sessions ADD COLUMN total_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN token_breakdown TEXT;
