-- Migration 014: Recreate cascade trigger after table rename.
-- Migration 013 renamed session_files → session_files_legacy. SQLite's
-- ALTER TABLE RENAME auto-updated the trigger body to reference
-- session_files_legacy. After the legacy migrator drops that table, the
-- trigger is broken. Recreate it with the correct table name.

DROP TRIGGER IF EXISTS trg_sessions_before_delete_cascade;

CREATE TRIGGER trg_sessions_before_delete_cascade
BEFORE DELETE ON sessions
FOR EACH ROW
BEGIN
  DELETE FROM messages           WHERE session_id = OLD.id;
  DELETE FROM escalations        WHERE session_id = OLD.id;
  DELETE FROM human_messages     WHERE session_id = OLD.id;
  DELETE FROM session_files      WHERE session_id = OLD.id;
  DELETE FROM quality_scores     WHERE session_id = OLD.id;
  DELETE FROM session_archetypes WHERE session_id = OLD.id;
  DELETE FROM embedding_meta     WHERE session_id = OLD.id;
END;
