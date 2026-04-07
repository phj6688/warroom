-- Defense-in-depth: cascade-clean child rows whenever a session is deleted,
-- even if the connection that ran the DELETE had `PRAGMA foreign_keys = OFF`.
--
-- The existing FK constraints declare ON DELETE CASCADE, but SQLite only
-- enforces them when foreign_keys is enabled (per-connection). An ad-hoc
-- script once deleted from `sessions` with FKs off, leaving every child
-- table orphaned. This trigger guarantees the cleanup regardless of pragma.
--
-- It also covers `embedding_meta`, which uses session_id but has no FK.
-- The vec0 virtual table `session_embeddings` is intentionally NOT touched
-- here: it requires the `sqlite-vec` extension to be loaded in the calling
-- connection, and a trigger that aborts the parent DELETE just because an
-- ad-hoc script forgot to load an extension would be a bigger footgun than
-- the orphan vectors it would leave behind. The vector rows are harmless
-- without their embedding_meta link.
--
-- When foreign_keys IS on, the trigger runs first and deletes the children
-- explicitly; the subsequent FK cascade then has nothing to do, so this is
-- idempotent and safe with both pragma states.
CREATE TRIGGER IF NOT EXISTS trg_sessions_before_delete_cascade
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
