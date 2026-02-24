const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 8090;
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';

// LLM Proxy
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || null;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;

// Search — Tavily API for Research Scout
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
const SEARCH_MAX_RESULTS = parseInt(process.env.SEARCH_MAX_RESULTS || '5');

if (GATEWAY_URL && GATEWAY_TOKEN) {
  console.log(`✅ LLM proxy: OpenClaw Gateway at ${GATEWAY_URL}`);
} else if (ANTHROPIC_API_KEY) {
  console.log(`✅ LLM: Direct Anthropic API (${ANTHROPIC_API_KEY.slice(0, 12)}...)`);
} else {
  console.warn('⚠️  No LLM config — set OPENCLAW_GATEWAY_URL+TOKEN or ANTHROPIC_API_KEY');
}

if (TAVILY_API_KEY) {
  console.log(`✅ Search: Tavily API configured (Research Scout enabled)`);
} else {
  console.warn('⚠️  No TAVILY_API_KEY — Research Scout will operate without live search');
}

// ─── Database ────────────────────────────────────────────────
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'warroom.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    problem TEXT NOT NULL,
    phase INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_files (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER,
    type TEXT,
    content TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    agent_emoji TEXT,
    agent_color TEXT,
    content TEXT NOT NULL,
    phase TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    agent_emoji TEXT,
    question TEXT NOT NULL,
    answer TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS human_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_escalations_session ON escalations(session_id);
  CREATE INDEX IF NOT EXISTS idx_human_messages_session ON human_messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
`);

// Prepared statements
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
};

// File uploads
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0, setHeaders: (res) => { res.set('Cache-Control', 'no-store'); } }));
app.use(express.json({ limit: '10mb' }));

// File upload endpoint
app.post('/api/upload', upload.array('files', 10), (req, res) => {
  const files = (req.files || []).map(f => {
    const ext = path.extname(f.originalname).toLowerCase();
    const textExts = ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.html', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.css', '.sql', '.sh', '.log', '.env', '.toml', '.ini', '.cfg', '.conf', '.tex', '.rst', '.org'];
    let content = null;
    if (textExts.includes(ext)) {
      try { content = fs.readFileSync(f.path, 'utf-8').slice(0, 50000); } catch (e) { }
    }
    return { id: path.basename(f.path), name: f.originalname, size: f.size, type: f.mimetype, content };
  });
  res.json({ ok: true, files });
});

// ─── Agent Definitions ───────────────────────────────────────
const AGENTS = [
  {
    id: 'process-architect', name: 'Process Architect', emoji: '🎯', color: '#00ff41',
    role: 'Metacognitive Conductor', hat: 'Blue Hat',
    systemPrompt: `You are the Process Architect — the metacognitive conductor of a research war room with 8 specialized AI agents.

Your role:
- Manage the overall thinking process and deliberation flow
- Decide when to diverge (explore) vs converge (focus)
- Ensure equal participation across all agents
- Frame problems clearly before analysis begins
- Identify when the team needs external information

Cognitive style: Blue Hat thinking. You think ABOUT thinking. You orchestrate, sequence, and ensure quality of the deliberation process itself.

When you identify information gaps that require human input (internal documents, company-specific data, domain expertise, stakeholder preferences, budget constraints, regulatory specifics), you MUST flag them by including exactly this marker in your response:
NEED_HUMAN_INPUT: [Your specific question for the human]

Keep responses focused and structured. Use bullet points. Be directive about next steps.`
  },
  {
    id: 'systems-synthesizer', name: 'Systems Synthesizer', emoji: '🔗', color: '#00e639',
    role: 'Boundary Spanner', hat: 'Cross-Domain',
    systemPrompt: `You are the Systems Synthesizer — the boundary spanner in a research war room.

Your role:
- See cross-domain connections others miss
- Translate between different professional vocabularies
- Find structural analogies across fields
- Map system dynamics, feedback loops, and emergent properties
- Bridge technical and non-technical perspectives

Cognitive style: You think in systems, networks, and patterns. You see the forest AND the trees AND the mycelium connecting them underground.

When you identify information gaps that require human input (internal documents, company-specific data, domain expertise, organizational context), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Keep responses insightful. Use analogies. Show connections.`
  },
  {
    id: 'divergent-generator', name: 'Divergent Generator', emoji: '💡', color: '#00cc30',
    role: 'Creative Disruptor', hat: 'Green Hat',
    systemPrompt: `You are the Divergent Generator — the creative disruptor in a research war room.

Your role:
- Generate novel hypotheses and unconventional ideas
- Reframe problems from unexpected angles
- Expand the solution space beyond obvious approaches
- Challenge assumptions and "obvious" answers
- Propose wild ideas that might contain seeds of brilliance

Cognitive style: Green Hat thinking. Pure creative energy. No idea is too weird. You generate, you don't judge. Quantity and variety over polish.

When you identify information gaps that require human input (sample documents, creative constraints, stakeholder preferences, examples of prior work), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be bold. Be weird. Be generative. Number your ideas.`
  },
  {
    id: 'convergent-evaluator', name: 'Convergent Evaluator', emoji: '⚖️', color: '#00b328',
    role: 'Analytical Engine', hat: 'Black/White Hat',
    systemPrompt: `You are the Convergent Evaluator — the analytical engine in a research war room.

Your role:
- Apply Bayesian reasoning to assess probabilities
- Use Analysis of Competing Hypotheses (ACH) methodology
- Evaluate evidence quality and weight
- Identify which ideas have the strongest support
- Quantify uncertainty and confidence levels

Cognitive style: Black Hat (critical) + White Hat (data-driven). You are rigorous, evidence-based, and probabilistic. You assign likelihoods, not certainties.

When you identify information gaps that require human input (data sources, empirical evidence, prior results, quantitative constraints), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be precise. Use probability language. Structure evaluations clearly.`
  },
  {
    id: 'red-teamer', name: 'Red Teamer', emoji: '🔴', color: '#00991f',
    role: 'Adversarial Stress-Tester', hat: "Devil's Advocate",
    systemPrompt: `You are the Red Teamer — the adversarial stress-tester in a research war room.

Your role:
- Attack conclusions and expose weaknesses
- Run pre-mortems: "Assume this failed. Why?"
- Find failure modes, edge cases, and blind spots
- Challenge groupthink and comfortable consensus
- Identify second and third-order consequences

Cognitive style: You are the constructive antagonist. You break things to make them stronger. You find the crack in every argument, the flaw in every plan.

When you identify information gaps that require human input (risk tolerance, known constraints, historical failures, competitive intelligence), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be incisive. Be uncomfortable. Be necessary.`
  },
  {
    id: 'quantitative-expert', name: 'Quantitative Expert', emoji: '📐', color: '#008017',
    role: 'Technical Depth', hat: 'STEM',
    systemPrompt: `You are the Quantitative Expert — the technical depth specialist in a research war room.

Your role:
- Provide engineering, math, CS, and physical sciences perspective
- Assess technical feasibility and complexity
- Estimate resource requirements (compute, time, money)
- Identify technical risks and dependencies
- Propose concrete technical approaches

Cognitive style: You think in numbers, algorithms, architectures, and physical constraints. You ground abstract ideas in technical reality.

When you identify information gaps that require human input (tech stack details, infrastructure specs, performance requirements, existing codebases), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be specific. Use numbers. Estimate ranges. Ground everything in reality.`
  },
  {
    id: 'qualitative-expert', name: 'Qualitative Expert', emoji: '📜', color: '#00660f',
    role: 'Institutional Depth', hat: 'Policy/Business',
    systemPrompt: `You are the Qualitative Expert — the institutional depth specialist in a research war room.

Your role:
- Analyze legal, regulatory, and compliance implications
- Assess organizational behavior and change management
- Map incentive structures and stakeholder dynamics
- Evaluate financial models and business viability
- Consider cultural, political, and social factors

Cognitive style: You think in institutions, incentives, regulations, and human systems. You understand that technically correct ≠ actually implementable.

When you identify information gaps that require human input (regulatory requirements, organizational structure, budget, legal constraints, stakeholder map), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be practical. Consider implementation. Think about people and power.`
  },
  {
    id: 'research-scout', name: 'Research Scout', emoji: '🔍', color: '#00ff41',
    role: 'Information Architect', hat: 'Intel',
    systemPrompt: `You are the Research Scout — the information architect in a research war room.

Your role:
- Identify what information is needed and what's missing
- Evaluate source quality and reliability
- Organize and structure the team's knowledge base
- Flag knowledge gaps and information asymmetries
- Suggest research directions and data sources

You have LIVE INTERNET SEARCH capability. When you need to look something up, include search queries using this exact marker (one per line, up to 5 queries):
SEARCH: [your search query]

Examples:
SEARCH: knowledge graph insurance tariff data best practices
SEARCH: neo4j vs dgraph performance comparison 2025

After your searches execute, you will receive the results and get a second turn to synthesize findings for the team. Use specific, targeted queries. Don't search for things you already know well.

Cognitive style: You are the team's librarian, intelligence analyst, and search engine combined. You know what you know, what you don't know, and what you don't know you don't know.

When you identify information gaps that require human input (internal documents, proprietary data, unpublished research, institutional knowledge), you MUST flag them by including exactly this marker:
NEED_HUMAN_INPUT: [Your specific question for the human]

Be organized. Cite what you reference. Flag confidence levels on information.`
  }
];

// ─── Session State (in-memory cache backed by DB) ────────────
const activeSessions = new Map(); // Only active sessions in memory

const PHASES = [
  { id: 'framing', name: 'Problem Framing', agents: ['process-architect', 'research-scout', 'systems-synthesizer'] },
  { id: 'divergence', name: 'Divergence', agents: ['divergent-generator', 'systems-synthesizer', 'quantitative-expert', 'qualitative-expert'] },
  { id: 'convergence', name: 'Convergence', agents: ['convergent-evaluator', 'quantitative-expert', 'qualitative-expert', 'research-scout'] },
  { id: 'red-team', name: 'Red Team', agents: ['red-teamer', 'convergent-evaluator', 'process-architect'] },
  { id: 'synthesis', name: 'Synthesis', agents: ['process-architect'] }
];

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createSession(problem, files = []) {
  const id = genId();
  const now = Date.now();

  // Insert into DB
  stmts.insertSession.run(id, problem, now, now);

  // Store files
  files.forEach(f => {
    stmts.insertFile.run(f.id || genId(), id, f.name, f.size || 0, f.type || '', f.content || null, now);
  });

  // In-memory state for active deliberation
  const session = {
    id, problem, files, phase: 0,
    messages: [], humanMessages: [], escalations: [],
    agentStates: {}, active: true, createdAt: now
  };
  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  activeSessions.set(id, session);
  return session;
}

function loadSession(id) {
  const row = stmts.getSession.get(id);
  if (!row) return null;

  const messages = stmts.getSessionMessages.all(id).map(m => ({
    id: m.id, agentId: m.agent_id, agentName: m.agent_name,
    agentEmoji: m.agent_emoji, agentColor: m.agent_color,
    content: m.content, phase: m.phase, timestamp: m.created_at
  }));

  const escalations = stmts.getSessionEscalations.all(id).map(e => ({
    id: e.id, agentId: e.agent_id, agentName: e.agent_name, agentEmoji: e.agent_emoji,
    question: e.question, sessionId: id, answered: e.status === 'answered',
    answer: e.answer, createdAt: e.created_at
  }));

  const humanMessages = stmts.getSessionHumanMessages.all(id).map(h => ({
    id: h.id, content: h.content, timestamp: h.created_at
  }));

  const files = stmts.getSessionFiles.all(id).map(f => ({
    id: f.id, name: f.name, size: f.size, type: f.type, content: f.content
  }));

  return {
    id: row.id, problem: row.problem, phase: row.phase,
    active: !!row.active, messages, escalations, humanMessages,
    files, agentStates: {}, createdAt: row.created_at
  };
}

// ─── LLM Call ────────────────────────────────────────────────
async function callAnthropic(systemPrompt, messages, agentId) {
  if (GATEWAY_URL && GATEWAY_TOKEN) {
    const openaiMessages = [{ role: 'system', content: systemPrompt }, ...messages];
    const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: openaiMessages })
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Gateway error (${res.status}): ${err}`); }
    const data = await res.json();
    return data.choices[0].message.content;
  }
  if (ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({ model: MODEL, max_tokens: 1500, system: systemPrompt, messages });
    return response.content[0].text;
  }
  throw new Error('No LLM configuration available');
}

// ─── Broadcast ───────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}

// ─── Tavily Search ───────────────────────────────────────────
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: SEARCH_MAX_RESULTS,
        search_depth: 'basic',
        include_answer: true,
      }),
    });
    if (!res.ok) {
      console.error(`Tavily search error (${res.status}):`, await res.text());
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('Tavily search failed:', err.message);
    return null;
  }
}

function extractSearchQueries(text) {
  const queries = [];
  const regex = /SEARCH:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const q = match[1].trim().replace(/^\[|\]$/g, '');
    if (q.length > 2) queries.push(q);
  }
  return queries.slice(0, 5); // max 5 queries per turn
}

async function executeSearches(queries) {
  const results = [];
  for (const query of queries) {
    const data = await tavilySearch(query);
    if (data) {
      const formatted = {
        query,
        answer: data.answer || null,
        sources: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          snippet: (r.content || '').slice(0, 500),
          score: r.score,
        })),
      };
      results.push(formatted);
    } else {
      results.push({ query, answer: null, sources: [], error: 'Search unavailable' });
    }
  }
  return results;
}

function formatSearchResults(results) {
  if (!results.length) return '';
  let text = '\n\n=== SEARCH RESULTS ===\n';
  results.forEach((r, i) => {
    text += `\n--- Search ${i + 1}: "${r.query}" ---\n`;
    if (r.error) { text += `[Search unavailable]\n`; return; }
    if (r.answer) text += `Summary: ${r.answer}\n`;
    if (r.sources.length) {
      text += `Sources:\n`;
      r.sources.forEach((s, j) => {
        text += `  ${j + 1}. ${s.title}\n     ${s.url}\n     ${s.snippet}\n`;
      });
    }
  });
  text += '\n=== END SEARCH RESULTS ===\n';
  return text;
}

function extractEscalations(text, agentId, sessionId) {
  const escalations = [];
  const regex = /NEED_HUMAN_INPUT:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    escalations.push({
      id: genId(), agentId, question: match[1].trim(),
      sessionId, answered: false, answer: null, createdAt: Date.now()
    });
  }
  return escalations;
}

function buildContext(session, agentId, phase) {
  const agent = AGENTS.find(a => a.id === agentId);
  const phaseName = PHASES[phase].name;

  const priorMessages = session.messages.map(m => {
    const a = AGENTS.find(x => x.id === m.agentId);
    return `[${a ? a.name : 'Human'}]: ${m.content}`;
  }).join('\n\n');

  const answeredEscalations = session.escalations
    .filter(e => e.answered && e.agentId === agentId)
    .map(e => `Human answered your question "${e.question}": ${e.answer}`).join('\n');

  const otherAnswers = session.escalations
    .filter(e => e.answered && e.agentId !== agentId)
    .map(e => {
      const a = AGENTS.find(x => x.id === e.agentId);
      return `[Human responded to ${a ? a.name : 'agent'}]: Q: "${e.question}" A: ${e.answer}`;
    }).join('\n');

  let userContent = `PROBLEM: ${session.problem}\n\nCURRENT PHASE: ${phaseName}\n\n`;

  if (session.files && session.files.length > 0) {
    userContent += `ATTACHED FILES:\n`;
    session.files.forEach(f => {
      userContent += `--- ${f.name} (${f.type || 'unknown'}) ---\n`;
      if (f.content) userContent += f.content.slice(0, 10000) + (f.content.length > 10000 ? '\n[...truncated]' : '') + '\n';
      else userContent += `[Binary file, ${f.size} bytes]\n`;
    });
    userContent += '\n';
  }

  if (session.humanMessages && session.humanMessages.length > 0) {
    userContent += `HUMAN INTERJECTIONS (from the problem owner):\n`;
    session.humanMessages.forEach(hm => {
      userContent += `[Human @ ${new Date(hm.timestamp).toLocaleTimeString()}]: ${hm.content}\n`;
    });
    userContent += '\n';
  }

  if (priorMessages) userContent += `PRIOR DELIBERATION:\n${priorMessages}\n\n`;
  if (answeredEscalations) userContent += `YOUR ESCALATION ANSWERS:\n${answeredEscalations}\n\n`;
  if (otherAnswers) userContent += `SHARED HUMAN INPUT:\n${otherAnswers}\n\n`;

  userContent += `Now provide your contribution as ${agent.name} (${agent.role}) for the ${phaseName} phase. Stay in character. Be concise but thorough.`;

  if (phase === PHASES.length - 1 && agentId === 'process-architect') {
    userContent += `\n\nThis is the FINAL SYNTHESIS phase. Deliver a comprehensive summary that includes:
1. Key findings and recommendations
2. Confidence levels (high/medium/low) for each recommendation
3. Key uncertainties and open questions
4. Dissenting views and their merit
5. Recommended next steps
Format this as a clear, actionable brief.`;
  }

  return [{ role: 'user', content: userContent }];
}

async function runAgentTurn(session, agentId, phase) {
  const agent = AGENTS.find(a => a.id === agentId);
  const isResearchScout = agentId === 'research-scout';

  session.agentStates[agentId] = 'thinking';
  broadcast({ type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });

  try {
    const messages = buildContext(session, agentId, phase);
    let response = await callAnthropic(agent.systemPrompt, messages, agentId);

    // ─── Research Scout: two-pass search flow ─────────────────
    if (isResearchScout && TAVILY_API_KEY) {
      const searchQueries = extractSearchQueries(response);
      if (searchQueries.length > 0) {
        // Broadcast first pass (with search intent)
        session.agentStates[agentId] = 'searching';
        broadcast({ type: 'agent-state', agentId, state: 'searching', sessionId: session.id });
        broadcast({
          type: 'search-started',
          agentId,
          queries: searchQueries,
          sessionId: session.id,
        });

        console.log(`🔍 Research Scout searching: ${searchQueries.join(' | ')}`);

        // Execute searches
        const searchResults = await executeSearches(searchQueries);
        const resultsText = formatSearchResults(searchResults);

        broadcast({
          type: 'search-complete',
          agentId,
          resultCount: searchResults.reduce((n, r) => n + r.sources.length, 0),
          sessionId: session.id,
        });

        // Second pass: synthesize with search results
        session.agentStates[agentId] = 'thinking';
        broadcast({ type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });

        const synthesisMessages = [
          ...messages,
          { role: 'assistant', content: response },
          {
            role: 'user',
            content: `Your search queries have been executed. Here are the results:${resultsText}\n\nNow synthesize these findings into a comprehensive research brief for the team. Include:\n1. Key findings from the search results\n2. Source quality assessment\n3. How this information relates to the problem\n4. Remaining knowledge gaps\n\nDo NOT include any SEARCH: markers in this response.`,
          },
        ];

        response = await callAnthropic(agent.systemPrompt, synthesisMessages, agentId);
      }
    }
    // ─── End search flow ──────────────────────────────────────

    session.agentStates[agentId] = 'speaking';
    broadcast({ type: 'agent-state', agentId, state: 'speaking', sessionId: session.id });

    const now = Date.now();
    const msgId = genId();
    const msg = {
      id: msgId, agentId, agentName: agent.name, agentEmoji: agent.emoji,
      agentColor: agent.color, content: response, phase: PHASES[phase].name, timestamp: now
    };
    session.messages.push(msg);

    // Persist
    stmts.insertMessage.run(msgId, session.id, agentId, agent.name, agent.emoji, agent.color, response, PHASES[phase].name, now);

    broadcast({ type: 'message', ...msg, sessionId: session.id });

    // Escalations
    const escalations = extractEscalations(response, agentId, session.id);
    escalations.forEach(esc => {
      session.escalations.push(esc);
      stmts.insertEscalation.run(esc.id, session.id, agentId, agent.name, agent.emoji, esc.question, esc.createdAt);
      broadcast({ type: 'escalation', ...esc, agentName: agent.name, agentEmoji: agent.emoji });
    });

    session.agentStates[agentId] = 'idle';
    broadcast({ type: 'agent-state', agentId, state: 'idle', sessionId: session.id });

    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    console.error(`Agent ${agentId} error:`, err.message);
    session.agentStates[agentId] = 'idle';
    broadcast({ type: 'agent-state', agentId, state: 'idle', sessionId: session.id });
    broadcast({ type: 'error', agentId, message: `${agent.name} encountered an error: ${err.message}`, sessionId: session.id });
  }
}

async function runDeliberation(session) {
  for (let phaseIdx = 0; phaseIdx < PHASES.length; phaseIdx++) {
    if (!session.active) break;

    session.phase = phaseIdx;
    stmts.updateSessionPhase.run(phaseIdx, Date.now(), session.id);

    const phase = PHASES[phaseIdx];
    broadcast({ type: 'phase-change', phase: phaseIdx, phaseName: phase.name, phaseAgents: phase.agents, sessionId: session.id });

    for (const agentId of phase.agents) {
      if (!session.active) break;

      const pending = session.escalations.filter(e => !e.answered);
      if (pending.length > 0) {
        broadcast({ type: 'waiting-for-human', pendingCount: pending.length, sessionId: session.id });
        let waited = 0;
        while (session.escalations.some(e => !e.answered) && waited < 300000 && session.active) {
          await new Promise(r => setTimeout(r, 2000));
          waited += 2000;
        }
        if (waited >= 300000) {
          broadcast({ type: 'escalation-timeout', message: 'Proceeding without human input (timeout)', sessionId: session.id });
        }
      }

      await runAgentTurn(session, agentId, phaseIdx);
    }
  }

  session.active = false;
  stmts.updateSessionActive.run(0, Date.now(), session.id);
  activeSessions.delete(session.id);
  broadcast({ type: 'deliberation-complete', sessionId: session.id });
}

// ─── Follow-up Q&A (post-deliberation) ───────────────────────
async function runFollowUp(sessionId, session, question) {
  // Pick the best agent to answer based on the question
  // Process Architect synthesizes, but Research Scout handles research questions
  const responderId = 'process-architect';
  const agent = AGENTS.find(a => a.id === responderId);

  broadcast({ type: 'agent-state', agentId: responderId, state: 'thinking', sessionId });

  try {
    // Build context from full session history
    const priorMessages = (session.messages || []).map(m => {
      const a = AGENTS.find(x => x.id === m.agentId);
      return `[${a ? a.name : m.agentName || 'Agent'}]: ${m.content}`;
    }).join('\n\n');

    const humanHistory = (session.humanMessages || []).map(h => `[Human]: ${h.content}`).join('\n');

    const systemPrompt = `You are the Process Architect responding to a follow-up question after a completed War Room deliberation.

You have access to the full deliberation history. Answer the human's question directly, drawing on the insights and analysis from all 8 agents' contributions. Be concise, specific, and actionable.

If the question requires information that wasn't covered in the deliberation, say so and suggest what additional research would help.`;

    const userContent = `ORIGINAL PROBLEM: ${session.problem}

DELIBERATION SUMMARY (all agents' contributions):
${priorMessages}

${humanHistory ? `HUMAN MESSAGES:\n${humanHistory}\n\n` : ''}FOLLOW-UP QUESTION: ${question}

Answer this question based on the deliberation above. Be direct and specific.`;

    const response = await callAnthropic(systemPrompt, [{ role: 'user', content: userContent }], responderId);

    broadcast({ type: 'agent-state', agentId: responderId, state: 'speaking', sessionId });

    const now = Date.now();
    const msgId = genId();
    const msg = {
      id: msgId, agentId: responderId, agentName: agent.name, agentEmoji: agent.emoji,
      agentColor: agent.color, content: response, phase: 'Follow-up', timestamp: now
    };

    stmts.insertMessage.run(msgId, sessionId, responderId, agent.name, agent.emoji, agent.color, response, 'Follow-up', now);
    broadcast({ type: 'message', ...msg, sessionId });

    broadcast({ type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
  } catch (err) {
    console.error('Follow-up error:', err.message);
    broadcast({ type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
    broadcast({ type: 'error', agentId: responderId, message: `Follow-up failed: ${err.message}`, sessionId });
  }
}

// ─── WebSocket ───────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Send sessions list from DB
  const sessionList = stmts.getRecentSessions.all().map(s => ({
    id: s.id, problem: s.problem, phase: s.phase,
    active: !!s.active, messageCount: stmts.getSessionMessages.all(s.id).length,
    createdAt: s.created_at
  }));
  ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList }));
  ws.send(JSON.stringify({ type: 'agents', agents: AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })) }));
  ws.send(JSON.stringify({ type: 'phases', phases: PHASES }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);

      switch (msg.type) {
        case 'new-session': {
          const session = createSession(msg.problem, msg.files || []);
          broadcast({
            type: 'session-created',
            session: {
              id: session.id, problem: session.problem,
              files: (session.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })),
              phase: session.phase, active: session.active, createdAt: session.createdAt
            }
          });
          runDeliberation(session).catch(err => {
            console.error('Deliberation error:', err);
            broadcast({ type: 'error', message: err.message, sessionId: session.id });
          });
          break;
        }

        case 'escalation-response': {
          const session = activeSessions.get(msg.sessionId);
          if (!session) break;
          const esc = session.escalations.find(e => e.id === msg.escalationId);
          if (esc) {
            esc.answered = true;
            esc.answer = msg.answer;
            stmts.answerEscalation.run(msg.answer, Date.now(), msg.escalationId);
            broadcast({ type: 'escalation-answered', escalationId: esc.id, answer: msg.answer, sessionId: session.id });
          }
          break;
        }

        case 'join-session': {
          // Try active first, then load from DB
          let session = activeSessions.get(msg.sessionId);
          if (!session) session = loadSession(msg.sessionId);
          if (session) {
            ws.send(JSON.stringify({
              type: 'session-state',
              session: {
                id: session.id, problem: session.problem, phase: session.phase,
                active: session.active, messages: session.messages,
                escalations: session.escalations, humanMessages: session.humanMessages || [],
                agentStates: session.agentStates || {}, createdAt: session.createdAt
              }
            }));
          }
          break;
        }

        case 'human-message': {
          // Try active session first, then load from DB for follow-ups
          let session = activeSessions.get(msg.sessionId);
          const isFollowUp = !session || !session.active;

          if (!session) {
            // Load completed session for follow-up
            session = loadSession(msg.sessionId);
          }

          if (session) {
            const now = Date.now();
            const hmId = genId();
            const hm = { id: hmId, content: msg.content, timestamp: now };
            if (session.humanMessages) session.humanMessages.push(hm);
            stmts.insertHumanMessage.run(hmId, msg.sessionId, msg.content, now);
            broadcast({ type: 'human-message', ...hm, sessionId: msg.sessionId });

            // If session is complete, trigger a follow-up response from Process Architect
            if (isFollowUp && msg.content.trim()) {
              runFollowUp(msg.sessionId, session, msg.content).catch(err => {
                console.error('Follow-up error:', err.message);
                broadcast({ type: 'error', message: `Follow-up failed: ${err.message}`, sessionId: msg.sessionId });
              });
            }
          }
          break;
        }

        case 'stop-session': {
          const session = activeSessions.get(msg.sessionId);
          if (session) {
            session.active = false;
            stmts.updateSessionActive.run(0, Date.now(), session.id);
            activeSessions.delete(session.id);
            broadcast({ type: 'session-stopped', sessionId: session.id });
          }
          break;
        }

        case 'get-sessions': {
          const sessions = stmts.getRecentSessions.all().map(s => ({
            id: s.id, problem: s.problem, phase: s.phase,
            active: !!s.active, createdAt: s.created_at
          }));
          ws.send(JSON.stringify({ type: 'sessions', sessions }));
          break;
        }

        case 'delete-session': {
          if (msg.sessionId) {
            db.prepare('DELETE FROM sessions WHERE id = ?').run(msg.sessionId);
            activeSessions.delete(msg.sessionId);
            broadcast({ type: 'session-deleted', sessionId: msg.sessionId });
          }
          break;
        }
      }
    } catch (err) {
      console.error('WS message error:', err);
    }
  });

  ws.on('close', () => console.log('Client disconnected'));
});

// ─── REST endpoints ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
  res.json({ status: 'ok', service: 'war-room', sessions: sessionCount, activeSessions: activeSessions.size, uptime: process.uptime() });
});

app.get('/api/agents', (req, res) => {
  res.json(AGENTS.map(a => ({ id: a.id, name: a.name, emoji: a.emoji, color: a.color, role: a.role, hat: a.hat })));
});

app.get('/api/sessions', (req, res) => {
  const sessions = stmts.getRecentSessions.all().map(s => ({
    id: s.id, problem: s.problem, phase: s.phase,
    active: !!s.active, createdAt: s.created_at,
    messageCount: stmts.getSessionMessages.all(s.id).length
  }));
  res.json(sessions);
});

app.get('/api/search', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const like = `%${q}%`;
  const sessions = db.prepare(`
    SELECT DISTINCT s.id, s.problem, s.phase, s.active, s.created_at, s.updated_at
    FROM sessions s
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE LOWER(s.problem) LIKE ? OR LOWER(m.content) LIKE ?
    ORDER BY s.updated_at DESC LIMIT 20
  `).all(like, like);
  res.json(sessions.map(s => ({
    id: s.id, problem: s.problem, phase: s.phase,
    active: !!s.active, createdAt: s.created_at,
    messageCount: stmts.getSessionMessages.all(s.id).length
  })));
});

app.get('/api/sessions/:id', (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// ─── MCP Server Setup ────────────────────────────────────────
const { setupMCPServer } = require('./mcp-server.js');

setupMCPServer(app, {
  db: stmts,
  callLLM: callAnthropic,
  createSession,
  activeSessions,
  AGENTS,
  PHASES,
});

// ─── Graceful shutdown ───────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  // Mark active sessions as inactive
  activeSessions.forEach((session) => {
    session.active = false;
    stmts.updateSessionActive.run(0, Date.now(), session.id);
  });
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

// ─── Start server ────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏛️  AI Research War Room`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   Database: ${path.join(dataDir, 'warroom.db')}`);
  console.log(`   WebSocket ready`);
  console.log(`   Model: ${MODEL}\n`);
});
