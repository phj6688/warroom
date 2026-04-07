-- F4 — Boot reconciliation tag for orphaned active sessions.
--
-- Sessions whose process died mid-deliberation leave their row at active=1
-- with no in-memory state to drive them. On boot the server marks each such
-- row active=0 and stamps crash_recovered_at so the operator can see how a
-- given session ended without confusing it with a clean completion.
--
-- Default policy: do NOT auto-resume. LLM calls cost money and silent
-- re-runs without human consent are worse than a stalled row.
ALTER TABLE sessions ADD COLUMN crash_recovered_at INTEGER;
