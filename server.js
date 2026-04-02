const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

// ─── Modules ────────────────────────────────────────────────
const { db, stmts } = require('./db');
const { AGENTS } = require('./lib/agents');
const { PHASES } = require('./lib/phases');
const { callAnthropic } = require('./lib/llm');
const { setupRoutes } = require('./lib/routes');
const { setupWebSocket } = require('./lib/ws-handler');
const { setupMCPServer } = require('./mcp/http');
const { createMemoryManager } = require('./lib/memory');
const { createQualityManager } = require('./lib/quality');
const { countTokens, trimContext, contextBudget } = require('./lib/tokens');

const PORT = process.env.PORT || 8090;

// ─── LLM config logging ────────────────────────────────────
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || null;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || null;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.MODEL || 'anthropic/claude-sonnet-4-5';
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || null;
const SEARCH_MAX_RESULTS = parseInt(process.env.SEARCH_MAX_RESULTS || '5');

if (GATEWAY_URL && GATEWAY_TOKEN) {
  console.log(`✅ LLM proxy: LLM gateway Gateway at ${GATEWAY_URL}`);
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

// ─── Express + WebSocket ────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── Shared State ───────────────────────────────────────────
const activeSessions = new Map();
const memory = createMemoryManager({ db, stmts, callAnthropic, AGENTS, PHASES });
const quality = createQualityManager({ db, stmts, callAnthropic, PHASES });

function genId() { return crypto.randomUUID(); }

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => { if (client.readyState === 1) client.send(msg); });
}

// ─── Session Management ─────────────────────────────────────
function createSession(problem, files = []) {
  const id = genId();
  const now = Date.now();
  stmts.insertSession.run(id, problem, now, now);
  files.forEach(f => {
    stmts.insertFile.run(f.id || genId(), id, f.name, f.size || 0, f.type || '', f.content || null, now);
  });
  const session = {
    id, problem, files, phase: 0,
    messages: [], humanMessages: [], escalations: [],
    agentStates: {}, active: true, createdAt: now
  };
  AGENTS.forEach(a => { session.agentStates[a.id] = 'idle'; });
  activeSessions.set(id, session);

  // Generate shadow (adversarial twin) answer async, non-blocking
  quality.generateShadowAnswer(id, problem).catch(err =>
    console.warn(`[quality] Shadow generation error: ${err.message}`)
  );

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
    files, agentStates: {}, createdAt: row.created_at, updatedAt: row.updated_at
  };
}

// ─── Tavily Search ──────────────────────────────────────────
async function tavilySearch(query) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_API_KEY}` },
      body: JSON.stringify({ query, max_results: SEARCH_MAX_RESULTS, search_depth: 'basic', include_answer: true }),
    });
    if (!res.ok) { console.error(`Tavily search error (${res.status}):`, await res.text()); return null; }
    return await res.json();
  } catch (err) { console.error('Tavily search failed:', err.message); return null; }
}

function extractSearchQueries(text) {
  const queries = [];
  const regex = /SEARCH:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const q = match[1].trim().replace(/^\[|\]$/g, '');
    if (q.length > 2) queries.push(q);
  }
  return queries.slice(0, 5);
}

async function executeSearches(queries) {
  const results = [];
  for (const query of queries) {
    const data = await tavilySearch(query);
    if (data) {
      results.push({
        query, answer: data.answer || null,
        sources: (data.results || []).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 500), score: r.score })),
      });
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
      r.sources.forEach((s, j) => { text += `  ${j + 1}. ${s.title}\n     ${s.url}\n     ${s.snippet}\n`; });
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
    escalations.push({ id: genId(), agentId, question: match[1].trim(), sessionId, answered: false, answer: null, createdAt: Date.now() });
  }
  return escalations;
}

// ─── Context Building ───────────────────────────────────────
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

  // Inject memory context for Process Architect in first phase only
  if (phase === 0 && agentId === 'process-architect' && session._memories && session._memories.length > 0) {
    userContent += memory.injectMemory(session._memories);
  }
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
    session.humanMessages.forEach(hm => { userContent += `[Human @ ${new Date(hm.timestamp).toLocaleTimeString()}]: ${hm.content}\n`; });
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

  // Token counting + budget enforcement (S01)
  const budget = contextBudget(MODEL);
  const systemTokens = countTokens(agent.systemPrompt);
  const contextTokens = countTokens(userContent);
  const totalTokens = systemTokens + contextTokens;
  const utilization = totalTokens / budget;

  if (utilization > 0.9) {
    // Auto-trim: remove oldest prior messages from context
    const trimmedContent = userContent.slice(0, Math.floor(userContent.length * (budget * 0.8) / totalTokens));
    console.log(`[tokens] TRIMMED context for ${agentId}: ${totalTokens} → ~${countTokens(trimmedContent)} tokens (${(utilization * 100).toFixed(0)}% of budget)`);
    return [{ role: 'user', content: trimmedContent }];
  }
  if (utilization > 0.8) {
    console.warn(`[tokens] WARNING: context for ${agentId} at ${(utilization * 100).toFixed(0)}% of budget (${totalTokens}/${budget} tokens)`);
  }

  return [{ role: 'user', content: userContent }];
}

// ─── Agent Turn ─────────────────────────────────────────────
async function runAgentTurn(session, agentId, phase) {
  const agent = AGENTS.find(a => a.id === agentId);
  const isResearchScout = agentId === 'research-scout';
  session.agentStates[agentId] = 'thinking';
  broadcast({ type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });

  try {
    const messages = buildContext(session, agentId, phase);
    let response = await callAnthropic(agent.systemPrompt, messages, agentId);

    if (isResearchScout && TAVILY_API_KEY) {
      const searchQueries = extractSearchQueries(response);
      if (searchQueries.length > 0) {
        session.agentStates[agentId] = 'searching';
        broadcast({ type: 'agent-state', agentId, state: 'searching', sessionId: session.id });
        broadcast({ type: 'search-started', agentId, queries: searchQueries, sessionId: session.id });
        console.log(`🔍 Research Scout searching: ${searchQueries.join(' | ')}`);
        const searchResults = await executeSearches(searchQueries);
        const resultsText = formatSearchResults(searchResults);
        broadcast({ type: 'search-complete', agentId, resultCount: searchResults.reduce((n, r) => n + r.sources.length, 0), sessionId: session.id });
        session.agentStates[agentId] = 'thinking';
        broadcast({ type: 'agent-state', agentId, state: 'thinking', sessionId: session.id });
        const synthesisMessages = [
          ...messages,
          { role: 'assistant', content: response },
          { role: 'user', content: `Your search queries have been executed. Here are the results:${resultsText}\n\nNow synthesize these findings into a comprehensive research brief for the team. Include:\n1. Key findings from the search results\n2. Source quality assessment\n3. How this information relates to the problem\n4. Remaining knowledge gaps\n\nDo NOT include any SEARCH: markers in this response.` },
        ];
        response = await callAnthropic(agent.systemPrompt, synthesisMessages, agentId);
      }
    }

    session.agentStates[agentId] = 'speaking';
    broadcast({ type: 'agent-state', agentId, state: 'speaking', sessionId: session.id });
    const now = Date.now();
    const msgId = genId();
    const msg = { id: msgId, agentId, agentName: agent.name, agentEmoji: agent.emoji, agentColor: agent.color, content: response, phase: PHASES[phase].name, timestamp: now };
    session.messages.push(msg);
    stmts.insertMessage.run(msgId, session.id, agentId, agent.name, agent.emoji, agent.color, response, PHASES[phase].name, now);
    broadcast({ type: 'message', ...msg, sessionId: session.id });

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

// ─── Deliberation Loop ─────────────────────────────────────
async function runDeliberation(session) {
  // Retrieve relevant prior sessions for memory injection
  try {
    const memories = await memory.retrieveSimilar(session.problem, 3);
    if (memories.length > 0) {
      session._memories = memories;
      stmts.updateSessionMemoryInjected.run(Date.now(), session.id);
      console.log(`🧠 Memory: ${memories.length} prior sessions injected for ${session.id}`);
    }
  } catch (err) {
    console.warn(`⚠️  Memory retrieval failed (proceeding without): ${err.message}`);
  }

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

  // Post-synthesis: embed session and extract archival facts
  memory.storeSessionMemory(session.id).catch(err =>
    console.warn(`⚠️  Post-session embedding failed: ${err.message}`)
  );
  memory.extractArchivalFacts(session.id).then(facts => {
    if (facts) console.log(`📋 Archival facts for ${session.id}: archetype="${facts.archetype || 'unknown'}"`);
  }).catch(err =>
    console.warn(`⚠️  Archival fact extraction failed: ${err.message}`)
  );

  // Quality evaluation — async, non-blocking, after deliberation-complete
  quality.evaluateSession(session.id).then(result => {
    if (result) {
      console.log(`📊 Quality score for ${session.id}: ${result.score.toFixed(3)}`);
      broadcast({ type: 'quality-scored', sessionId: session.id, score: result.score, breakdown: result.breakdown });
    }
  }).catch(err =>
    console.warn(`[quality] Evaluation failed for ${session.id}: ${err.message}`)
  );

  const synthCount = db.prepare("SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND phase = 'Synthesis'").get(session.id).c;
  const qaCount = db.prepare('SELECT COUNT(*) as c FROM escalations WHERE session_id = ?').get(session.id).c;
  const totalMsgs = session.messages.length;
  broadcast({
    type: 'deliberation-complete', sessionId: session.id,
    export: {
      available: true,
      modes: [
        { id: 'full_transcript', label: 'Full Transcript (A–Z)', available: totalMsgs > 0 },
        { id: 'end_result', label: 'End Result Only', available: synthCount > 0 },
        { id: 'end_result_with_qa', label: 'End Result + Q&A', available: synthCount > 0 || qaCount > 0 },
      ],
      formats: ['txt', 'md', 'json'],
    }
  });
}

// ─── Follow-up Q&A ──────────────────────────────────────────
async function runFollowUp(sessionId, session, question) {
  const responderId = 'process-architect';
  const agent = AGENTS.find(a => a.id === responderId);
  broadcast({ type: 'agent-state', agentId: responderId, state: 'thinking', sessionId });

  try {
    const priorMessages = (session.messages || []).map(m => {
      const a = AGENTS.find(x => x.id === m.agentId);
      return `[${a ? a.name : m.agentName || 'Agent'}]: ${m.content}`;
    }).join('\n\n');
    const humanHistory = (session.humanMessages || []).map(h => `[Human]: ${h.content}`).join('\n');
    const systemPrompt = `You are the Process Architect responding to a follow-up question after a completed War Room deliberation.\n\nYou have access to the full deliberation history. Answer the human's question directly, drawing on the insights and analysis from all 8 agents' contributions. Be concise, specific, and actionable.\n\nIf the question requires information that wasn't covered in the deliberation, say so and suggest what additional research would help.`;
    const userContent = `ORIGINAL PROBLEM: ${session.problem}\n\nDELIBERATION SUMMARY (all agents' contributions):\n${priorMessages}\n\n${humanHistory ? `HUMAN MESSAGES:\n${humanHistory}\n\n` : ''}FOLLOW-UP QUESTION: ${question}\n\nAnswer this question based on the deliberation above. Be direct and specific.`;
    const response = await callAnthropic(systemPrompt, [{ role: 'user', content: userContent }], responderId);

    broadcast({ type: 'agent-state', agentId: responderId, state: 'speaking', sessionId });
    const now = Date.now();
    const msgId = genId();
    const msg = { id: msgId, agentId: responderId, agentName: agent.name, agentEmoji: agent.emoji, agentColor: agent.color, content: response, phase: 'Follow-up', timestamp: now };
    stmts.insertMessage.run(msgId, sessionId, responderId, agent.name, agent.emoji, agent.color, response, 'Follow-up', now);
    broadcast({ type: 'message', ...msg, sessionId });
    broadcast({ type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
  } catch (err) {
    console.error('Follow-up error:', err.message);
    broadcast({ type: 'agent-state', agentId: responderId, state: 'idle', sessionId });
    broadcast({ type: 'error', agentId: responderId, message: `Follow-up failed: ${err.message}`, sessionId });
  }
}

// ─── Wire Modules ───────────────────────────────────────────
const deps = { db, stmts, AGENTS, PHASES, activeSessions, callAnthropic, createSession, loadSession, runDeliberation, runFollowUp, broadcast, memory, quality };

setupRoutes(app, deps);
setupWebSocket(wss, deps);
setupMCPServer(app, { db: stmts, callLLM: callAnthropic, createSession, runDeliberation, activeSessions, AGENTS, PHASES });

// ─── Graceful Shutdown ──────────────────────────────────────
function shutdown() {
  console.log('Shutting down...');
  activeSessions.forEach((session) => {
    session.active = false;
    stmts.updateSessionActive.run(0, Date.now(), session.id);
  });
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ──────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🏛️  AI Research War Room`);
  console.log(`   Server running on http://localhost:${PORT}`);
  console.log(`   Database: ${path.join(__dirname, 'data', 'warroom.db')}`);
  console.log(`   WebSocket ready`);
  console.log(`   Model: ${MODEL}\n`);

  // Retroactive quality scoring on first boot (async, non-blocking)
  quality.retroactiveScore().catch(err =>
    console.warn(`[quality] Retroactive scoring error: ${err.message}`)
  );
});
