const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || '/data/warroom.db';
const dbDir = path.dirname(DB_PATH);

// Ensure data directory exists
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH, { verbose: console.log });
db.pragma('journal_mode = WAL');

// ─── Schema Migration ────────────────────────────────────────
function migrate() {
  console.log('🗄️  Running database migrations...');

  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      problem TEXT NOT NULL,
      phase INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      synthesis_complete INTEGER NOT NULL DEFAULT 0,
      files TEXT, -- JSON array
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      agent_emoji TEXT,
      agent_color TEXT,
      role TEXT NOT NULL, -- 'agent' or 'human'
      content TEXT NOT NULL,
      phase TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Escalations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_name TEXT,
      agent_emoji TEXT,
      question TEXT NOT NULL,
      answer TEXT,
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' or 'answered'
      created_at INTEGER NOT NULL,
      answered_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);
    CREATE INDEX IF NOT EXISTS idx_escalations_status ON escalations(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);
  `);

  console.log('✅ Database ready');
}

migrate();

// ─── Session Operations ──────────────────────────────────────
const createSession = db.prepare(`
  INSERT INTO sessions (id, problem, phase, active, synthesis_complete, files, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getSession = db.prepare(`
  SELECT * FROM sessions WHERE id = ?
`);

const getAllSessions = db.prepare(`
  SELECT id, problem, phase, active, synthesis_complete, created_at, updated_at,
    (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) as message_count,
    (SELECT COUNT(*) FROM escalations WHERE session_id = sessions.id) as escalation_count
  FROM sessions
  ORDER BY created_at DESC
`);

const updateSessionPhase = db.prepare(`
  UPDATE sessions SET phase = ?, updated_at = ? WHERE id = ?
`);

const updateSessionStatus = db.prepare(`
  UPDATE sessions SET active = ?, synthesis_complete = ?, updated_at = ? WHERE id = ?
`);

const deleteSession = db.prepare(`
  DELETE FROM sessions WHERE id = ?
`);

// ─── Message Operations ──────────────────────────────────────
const createMessage = db.prepare(`
  INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, role, content, phase, pinned, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getMessagesBySession = db.prepare(`
  SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC
`);

const toggleMessagePin = db.prepare(`
  UPDATE messages SET pinned = 1 - pinned WHERE id = ?
`);

// ─── Escalation Operations ───────────────────────────────────
const createEscalation = db.prepare(`
  INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, answer, status, created_at, answered_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getEscalationsBySession = db.prepare(`
  SELECT * FROM escalations WHERE session_id = ? ORDER BY created_at ASC
`);

const answerEscalation = db.prepare(`
  UPDATE escalations SET answer = ?, status = 'answered', answered_at = ? WHERE id = ?
`);

// ─── Exported Functions ──────────────────────────────────────
function saveSession(session) {
  const now = Date.now();
  createSession.run(
    session.id,
    session.problem,
    session.phase || 0,
    session.active ? 1 : 0,
    session.synthesisComplete ? 1 : 0,
    JSON.stringify(session.files || []),
    session.createdAt || now,
    now
  );
}

function loadSession(sessionId) {
  const session = getSession.get(sessionId);
  if (!session) return null;

  const messages = getMessagesBySession.all(sessionId);
  const escalations = getEscalationsBySession.all(sessionId);

  return {
    id: session.id,
    problem: session.problem,
    phase: session.phase,
    active: Boolean(session.active),
    synthesisComplete: Boolean(session.synthesis_complete),
    files: JSON.parse(session.files || '[]'),
    messages: messages.map(m => ({
      id: m.id,
      agentId: m.agent_id,
      agentName: m.agent_name,
      agentEmoji: m.agent_emoji,
      agentColor: m.agent_color,
      role: m.role,
      content: m.content,
      phase: m.phase,
      pinned: Boolean(m.pinned),
      timestamp: m.created_at
    })),
    escalations: escalations.map(e => ({
      id: e.id,
      sessionId: e.session_id,
      agentId: e.agent_id,
      agentName: e.agent_name,
      agentEmoji: e.agent_emoji,
      question: e.question,
      answer: e.answer,
      answered: e.status === 'answered',
      createdAt: e.created_at
    })),
    humanMessages: [], // Reconstruct from messages with role='human'
    agentStates: {}, // Runtime state, not persisted
    createdAt: session.created_at
  };
}

function listSessions() {
  return getAllSessions.all().map(s => ({
    id: s.id,
    problem: s.problem,
    phase: s.phase,
    active: Boolean(s.active),
    synthesisComplete: Boolean(s.synthesis_complete),
    messageCount: s.message_count,
    escalationCount: s.escalation_count,
    createdAt: s.created_at,
    updatedAt: s.updated_at
  }));
}

function removeSession(sessionId) {
  deleteSession.run(sessionId);
}

function saveMessage(message, sessionId) {
  const now = Date.now();
  updateSessionStatus.run(1, 0, now, sessionId); // Update session timestamp

  createMessage.run(
    message.id,
    sessionId,
    message.agentId || null,
    message.agentName || null,
    message.agentEmoji || null,
    message.agentColor || null,
    message.role || 'agent',
    message.content,
    message.phase || null,
    message.pinned ? 1 : 0,
    message.timestamp || now
  );
}

function saveEscalation(escalation, sessionId) {
  const now = Date.now();
  updateSessionStatus.run(1, 0, now, sessionId); // Update session timestamp

  createEscalation.run(
    escalation.id,
    sessionId,
    escalation.agentId,
    escalation.agentName || null,
    escalation.agentEmoji || null,
    escalation.question,
    escalation.answer || null,
    escalation.answered ? 'answered' : 'pending',
    escalation.createdAt || now,
    escalation.answered ? now : null
  );
}

function updateEscalationAnswer(escalationId, answer) {
  answerEscalation.run(answer, Date.now(), escalationId);
}

function updatePhase(sessionId, phase) {
  updateSessionPhase.run(phase, Date.now(), sessionId);
}

function updateStatus(sessionId, active, synthesisComplete) {
  updateSessionStatus.run(active ? 1 : 0, synthesisComplete ? 1 : 0, Date.now(), sessionId);
}

function pinMessage(messageId) {
  toggleMessagePin.run(messageId);
}

module.exports = {
  db,
  saveSession,
  loadSession,
  listSessions,
  removeSession,
  saveMessage,
  saveEscalation,
  updateEscalationAnswer,
  updatePhase,
  updateStatus,
  pinMessage
};
