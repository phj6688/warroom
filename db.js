const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'warroom.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
sqliteVec.load(db);

// ─── Migration Runner ───────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER
  )
`);

function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const currentRow = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
  const currentVersion = currentRow ? currentRow.version : 0;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d{3}_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    console.log(`  Migration ${file} applied`);
  }
}

console.log('🗄️  Running database migrations...');
runMigrations();

// ─── sqlite-vec virtual table (created after migrations) ────
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS session_embeddings USING vec0(
    embedding FLOAT[768]
  )
`);

// Metadata table for embedding entries (vec0 only stores rowid + vector)
db.exec(`
  CREATE TABLE IF NOT EXISTS embedding_meta (
    rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

console.log('✅ Database ready');

// ─── Prepared Statements ────────────────────────────────────
const stmts = {
  insertSession: db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 1, ?, ?)'),
  updateSessionPhase: db.prepare('UPDATE sessions SET phase = ?, updated_at = ? WHERE id = ?'),
  updateSessionActive: db.prepare('UPDATE sessions SET active = ?, updated_at = ? WHERE id = ?'),
  insertFile: db.prepare('INSERT INTO session_files (id, session_id, name, size, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  insertMessage: db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  insertEscalation: db.prepare('INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, answer, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, NULL, \'pending\', ?, NULL)'),
  answerEscalation: db.prepare('UPDATE escalations SET status = \'answered\', answer = ?, answered_at = ? WHERE id = ?'),
  insertHumanMessage: db.prepare('INSERT INTO human_messages (id, session_id, content, created_at) VALUES (?, ?, ?, ?)'),
  getSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC'),
  getSession: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getSessionMessages: db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionEscalations: db.prepare('SELECT * FROM escalations WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionHumanMessages: db.prepare('SELECT * FROM human_messages WHERE session_id = ? ORDER BY created_at ASC'),
  getSessionFiles: db.prepare('SELECT * FROM session_files WHERE session_id = ? ORDER BY created_at ASC'),
  getRecentSessions: db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50'),
  getPendingEscalations: db.prepare('SELECT * FROM escalations WHERE session_id = ? AND status = \'pending\''),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  getAllPendingEscalations: db.prepare("SELECT * FROM escalations WHERE status = 'pending' ORDER BY created_at DESC"),
  searchSessions: db.prepare("SELECT DISTINCT s.id, s.problem, s.phase, s.active, s.created_at, s.updated_at FROM sessions s LEFT JOIN messages m ON m.session_id = s.id WHERE LOWER(s.problem) LIKE ? OR LOWER(m.content) LIKE ? ORDER BY s.updated_at DESC LIMIT 20"),
  countSessionMessages: db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?'),
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
  insertEmbedding: db.prepare('INSERT INTO session_embeddings(embedding) VALUES (?)'),
  insertEmbeddingMeta: db.prepare('INSERT INTO embedding_meta (rowid, session_id, content_type, created_at) VALUES (?, ?, ?, ?)'),
  getEmbeddingMetaBySession: db.prepare('SELECT * FROM embedding_meta WHERE session_id = ?'),
  deleteEmbeddingsBySession: db.prepare('DELETE FROM session_embeddings WHERE rowid IN (SELECT rowid FROM embedding_meta WHERE session_id = ?)'),
  deleteEmbeddingMetaBySession: db.prepare('DELETE FROM embedding_meta WHERE session_id = ?'),
};

module.exports = { db, stmts };
