const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./lib/migrations');

// WAR_ROOM_DB_PATH lets tests (and ops) point at an isolated DB file. When
// unset, fall back to the canonical ./data/warroom.db. The data dir is only
// auto-created for the default path; custom paths must already have a parent.
const dbPath = process.env.WAR_ROOM_DB_PATH
  ? path.resolve(process.env.WAR_ROOM_DB_PATH)
  : path.join(__dirname, 'data', 'warroom.db');

const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
sqliteVec.load(db);

// ─── Migration Runner (F8) ──────────────────────────────────
// Each pending migration runs in a transaction; checksums of applied
// migrations are verified on every boot. Bootstrap of the schema_version
// meta columns happens inside lib/migrations.js so a fresh DB and a
// pre-S4 DB both converge on the same shape.
//
// Boot diagnostics go to stderr so child processes that parse stdout as
// JSON (test runners, MCP clients) do not see them mixed into the payload.
console.error('🗄️  Running database migrations...');
runMigrations({ db, migrationsDir: path.join(__dirname, 'migrations'), log: console.error });

// vec0 virtual table needs sqlite-vec loaded in this connection, so it
// stays out of the migration runner. embedding_meta now lives in
// migrations/002_embedding_meta.sql so the cascade trigger in 010 and
// the RENAME in 013 can see it.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS session_embeddings USING vec0(
    embedding FLOAT[768]
  )
`);

console.error('✅ Database ready');

// ─── Prepared Statements ────────────────────────────────────
const stmts = {
  insertSession: db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)'),
  updateSessionPhase: db.prepare('UPDATE sessions SET phase = ?, updated_at = ? WHERE id = ?'),
  updateSessionActive: db.prepare('UPDATE sessions SET active = ?, updated_at = ? WHERE id = ?'),
  updateSessionOutcome: db.prepare('UPDATE sessions SET outcome = ?, failed_at = ?, updated_at = ? WHERE id = ?'),
  markCrashRecovered: db.prepare('UPDATE sessions SET active = 0, crash_recovered_at = ?, updated_at = ? WHERE id = ?'),
  getActiveSessions: db.prepare('SELECT id FROM sessions WHERE active = 1'),
  insertFile: db.prepare('INSERT OR IGNORE INTO session_files (session_id, file_id, file_sha256, file_name, file_tokens, file_mime, attached_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insertMessage: db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  insertEscalation: db.prepare('INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, \'pending\', ?, NULL)'),
  answerEscalation: db.prepare('UPDATE escalations SET status = \'answered\', answer = ?, answered_at = ? WHERE id = ?'),
  // Bulk / auto-resolve path also flags bulk_resolved so we can measure how
  // often the human carpet-bombs defaults vs engages (Red Team watch-metric).
  answerEscalationBulk: db.prepare('UPDATE escalations SET status = \'answered\', answer = ?, answered_at = ?, bulk_resolved = 1 WHERE id = ?'),
  insertHumanMessage: db.prepare('INSERT INTO human_messages (id, session_id, content, created_at) VALUES (?, ?, ?, ?)'),
  getSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getSessionMessages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionEscalations: db.prepare('SELECT * FROM escalations WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionHumanMessages: db.prepare('SELECT * FROM human_messages WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionFiles: db.prepare('SELECT * FROM session_files WHERE session_id = ? ORDER BY attached_at ASC'),
  // F16 — single SELECT with LEFT JOIN sub-queries so /api/sessions does not
  // fan out into 1 + 50 + 50 round-trips through enrichSession. The derived
  // tables collapse counts before the join so we still get one row per
  // session even when a session has many messages or escalations.
  getRecentSessions: db.prepare(`
    SELECT
      s.*,
      COALESCE(m.cnt, 0) AS message_count,
      COALESCE(e.cnt, 0) AS escalation_count
    FROM sessions s
    LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM messages GROUP BY session_id) m
      ON m.session_id = s.id
    LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM escalations GROUP BY session_id) e
      ON e.session_id = s.id
    ORDER BY s.created_at DESC
    LIMIT 50
  `),
  getPendingEscalations: db.prepare('SELECT * FROM escalations WHERE session_id = ? AND status = \'pending\''),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  getAllPendingEscalations: db.prepare("SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at DESC"),
  searchSessions: db.prepare("SELECT DISTINCT s.id, s.problem, s.phase, s.active, s.created_at, s.updated_at FROM sessions s LEFT JOIN messages m ON m.session_id = s.id WHERE LOWER(s.problem) LIKE ? OR LOWER(m.content) LIKE ? ORDER BY s.updated_at DESC LIMIT 20"),
  countSessionMessages: db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?'),
  countSessionEscalations: db.prepare('SELECT COUNT(*) as count FROM escalations WHERE session_id = ?'),
  // F17 — pulled in from inline `db.prepare(...)` sites in server.js and
  // lib/routes.js so prepared-statement caching works and the "all queries
  // in one place" pattern db.js was aiming for actually holds.
  countAllSessions: db.prepare('SELECT COUNT(*) as count FROM sessions'),
  synthCountForSession: db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND phase = 'Synthesis'"),
  escalationCountForSession: db.prepare('SELECT COUNT(*) as c FROM escalations WHERE session_id = ?'),
  messageCountForSession: db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?'),
  getEmbeddingMetaByRowid: db.prepare('SELECT session_id FROM embedding_meta WHERE rowid = ?'),
  toggleSessionPin: db.prepare('UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?'),
  updateSessionMemoryInjected: db.prepare('UPDATE sessions SET memory_injected = 1, updated_at = ? WHERE id = ?'),
  updateSessionQualityScore: db.prepare('UPDATE sessions SET quality_score = ?, updated_at = ? WHERE id = ?'),
  updateSessionShadowAnswer: db.prepare('UPDATE sessions SET shadow_answer = ?, updated_at = ? WHERE id = ?'),
  insertQualityScore: db.prepare('INSERT INTO quality_scores (id, session_id, phase_completion_rate, escalation_efficiency, synthesis_structure_score, cross_ref_count, shadow_delta, composite_score, evaluator_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  getQualityScore: db.prepare('SELECT * FROM quality_scores WHERE session_id = ?'),
  // Agent templates
  getActiveAgentTemplates: db.prepare('SELECT * FROM agent_templates WHERE active = 1 ORDER BY domain'),
  getAgentTemplateByDomain: db.prepare('SELECT * FROM agent_templates WHERE domain = ? AND active = 1 LIMIT 1'),
  getAgentTemplateById: db.prepare('SELECT * FROM agent_templates WHERE id = ?'),
  incrementAgentTemplateUsage: db.prepare('UPDATE agent_templates SET usage_count = usage_count + 1, updated_at = ? WHERE id = ?'),
  // Archetypes
  getArchetype: db.prepare('SELECT * FROM archetypes WHERE id = ?'),
  insertArchetype: db.prepare('INSERT OR IGNORE INTO archetypes (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
  insertSessionArchetype: db.prepare('INSERT OR REPLACE INTO session_archetypes (session_id, archetype_id, confidence) VALUES (?, ?, ?)'),
  // Session specialist tracking
  updateSessionArchetype: db.prepare('UPDATE sessions SET archetype_id = ?, updated_at = ? WHERE id = ?'),
  updateSessionSpecialists: db.prepare('UPDATE sessions SET specialist_agents = ?, updated_at = ? WHERE id = ?'),
  updateSessionPreset: db.prepare('UPDATE sessions SET preset_id = ?, updated_at = ? WHERE id = ?'),
  updateSessionContinuation: db.prepare('UPDATE sessions SET continues_from_session_id = ?, updated_at = ? WHERE id = ?'),
  updateSessionSynthesisQuality: db.prepare('UPDATE sessions SET synthesis_quality = ?, updated_at = ? WHERE id = ?'),
  insertEmbedding: db.prepare('INSERT INTO session_embeddings(embedding) VALUES (?)'),
  insertEmbeddingMeta: db.prepare('INSERT INTO embedding_meta (rowid, session_id, content_type, created_at) VALUES (?, ?, ?, ?)'),
  getEmbeddingMetaBySession: db.prepare('SELECT * FROM embedding_meta WHERE session_id = ?'),
  deleteEmbeddingsBySession: db.prepare('DELETE FROM session_embeddings WHERE rowid IN (SELECT rowid FROM embedding_meta WHERE session_id = ?)'),
  deleteEmbeddingMetaBySession: db.prepare('DELETE FROM embedding_meta WHERE session_id = ?'),
  // HLB-336 — runtime-editable settings (agent routing, later pricing).
  getSetting: db.prepare('SELECT value FROM app_settings WHERE key = ?'),
  getAllSettings: db.prepare('SELECT key, value FROM app_settings'),
  upsertSetting: db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'),
};

module.exports = { db, stmts, dbPath };
