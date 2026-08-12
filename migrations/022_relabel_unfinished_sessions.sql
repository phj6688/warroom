-- Relabel runs that never reached Synthesis but were recorded as completions.
--
-- Migration 021 classified a finished run by message count, so anything that
-- produced one message stored 'complete', and rows from before 021 carry NULL,
-- which every read path treats as a legacy completion. Both readings are wrong
-- for a run that was stopped, crashed, or refused partway: on the live DB, six
-- inactive rows with phase < 4 read as completions, including the session that
-- ended inside Problem Framing with three messages and a quality score.
--
-- The transcript is the authority, not the flag: a run with no Synthesis
-- message produced no verdict. One with no message at all produced nothing.
--
-- Deliberately narrow: an active row is left alone (it may still be running),
-- and a row already marked 'failed', 'stopped' or 'crashed' keeps its label.
-- Historical quality_scores rows are left in place; analytics already exclude a
-- session with no Synthesis message from the average.
UPDATE sessions
SET outcome = CASE
      WHEN (SELECT COUNT(*) FROM messages m WHERE m.session_id = sessions.id) = 0 THEN 'failed'
      ELSE 'stopped'
    END
WHERE active = 0
  AND (outcome IS NULL OR outcome = 'complete')
  AND id NOT IN (SELECT session_id FROM messages WHERE phase = 'Synthesis');
