const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { embed, estimateTokens, EMBEDDING_DIM } = require('./embeddings');
const { log } = require('./logger');

const MEMORY_TOKEN_BUDGET = 2000;
const RETRIEVAL_TIMEOUT = 2000; // 2s
const MEMORY_ANALYZER_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'meta', 'memory-analyzer.md'), 'utf-8'
).trim();

/**
 * Initialize memory module with dependencies.
 * Returns an object with all memory operations.
 */
function createMemoryManager(deps) {
  const { db, stmts, callAnthropic, AGENTS, PHASES } = deps;

  /**
   * Build a summary string for a session suitable for embedding.
   */
  // nomic-embed-text context is 8192 tokens (~32k chars). Stay well under.
  const MAX_SUMMARY_CHARS = 6000;

  function buildSessionSummary(sessionId) {
    const session = stmts.getSession.get(sessionId);
    if (!session) return null;

    const messages = stmts.getSessionMessages.all(sessionId);
    const synthesis = messages.filter(m => m.phase === 'Synthesis');
    const escalations = stmts.getSessionEscalations.all(sessionId);

    let summary = `Problem: ${session.problem.slice(0, 2000)}\n`;
    if (synthesis.length > 0) {
      summary += `\nSynthesis:\n${synthesis.map(m => m.content).join('\n\n').slice(0, 3000)}`;
    } else if (messages.length > 0) {
      // No synthesis yet — use first few agent messages as summary
      summary += `\nKey messages:\n${messages.slice(0, 3).map(m => `[${m.agent_name}]: ${m.content.slice(0, 500)}`).join('\n')}`;
    }
    if (escalations.length > 0) {
      const answered = escalations.filter(e => e.status === 'answered');
      if (answered.length > 0) {
        summary += `\nKey Q&A:\n${answered.slice(0, 3).map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n').slice(0, 800)}`;
      }
    }
    return summary.slice(0, MAX_SUMMARY_CHARS);
  }

  /**
   * Store embedding for a session. Embeds summary + key messages.
   */
  async function storeSessionMemory(sessionId) {
    const summary = buildSessionSummary(sessionId);
    if (!summary) return false;

    const embedding = await embed(summary);
    if (!embedding) {
      log.warn({ sessionId }, 'embed-gateway unavailable, skipping session embedding');
      return false;
    }

    // Clear existing embeddings for this session
    stmts.deleteEmbeddingsBySession.run(sessionId);
    stmts.deleteEmbeddingMetaBySession.run(sessionId);

    // Insert new embedding (vec0 auto-assigns rowid)
    const buf = Buffer.from(embedding.buffer);
    const info = stmts.insertEmbedding.run(buf);
    const rowid = Number(info.lastInsertRowid);
    stmts.insertEmbeddingMeta.run(rowid, sessionId, 'summary', Date.now());

    log.info({ sessionId, rowid }, 'session embedded');
    return true;
  }

  /**
   * Retrieve top-N similar sessions by cosine similarity.
   * Returns array of { id, problem, similarity, quality_score }.
   */
  async function retrieveSimilar(problemText, limit = 3) {
    const start = Date.now();

    const embedding = await embed(problemText);
    if (!embedding) return [];

    try {
      const buf = Buffer.from(embedding.buffer);
      // vec0 requires "k = ?" for KNN queries, not LIMIT
      const vecRows = db.prepare(
        'SELECT rowid, distance FROM session_embeddings WHERE embedding MATCH ? AND k = ?'
      ).all(buf, limit * 2); // fetch extra to handle dedup

      // Join with metadata
      const rows = vecRows.map(vr => {
        const meta = db.prepare('SELECT session_id, content_type FROM embedding_meta WHERE rowid = ?').get(vr.rowid);
        return meta ? { ...vr, session_id: meta.session_id, content_type: meta.content_type } : null;
      }).filter(Boolean);

      const elapsed = Date.now() - start;
      if (elapsed > 500) {
        log.warn({ elapsed }, 'memory retrieval slow (threshold 500ms)');
      }

      // Deduplicate by session_id, enrich with session data
      const seen = new Set();
      const results = [];
      for (const row of rows) {
        if (seen.has(row.session_id)) continue;
        seen.add(row.session_id);
        const session = stmts.getSession.get(row.session_id);
        if (!session) continue;
        results.push({
          id: session.id,
          problem: session.problem,
          similarity: 1 - row.distance, // vec0 returns distance, convert to similarity
          quality_score: session.quality_score || null,
        });
      }
      return results;
    } catch (err) {
      log.warn({ err: err.message }, 'memory retrieval error');
      return [];
    }
  }

  /**
   * Run the MemoryAnalyzer micro-agent to extract archival facts.
   */
  async function extractArchivalFacts(sessionId) {
    const session = stmts.getSession.get(sessionId);
    if (!session) return null;

    const messages = stmts.getSessionMessages.all(sessionId);
    const escalations = stmts.getSessionEscalations.all(sessionId);
    const humanMsgs = stmts.getSessionHumanMessages.all(sessionId);

    let transcript = `PROBLEM: ${session.problem}\n\n`;
    let currentPhase = null;
    for (const m of messages) {
      if (m.phase !== currentPhase) {
        currentPhase = m.phase;
        transcript += `\n--- ${currentPhase} ---\n\n`;
      }
      transcript += `[${m.agent_name}]: ${m.content}\n\n`;
    }

    if (escalations.length > 0) {
      transcript += '\n--- ESCALATIONS ---\n';
      for (const e of escalations) {
        transcript += `${e.agent_name} asked: "${e.question}"`;
        if (e.status === 'answered') transcript += ` → Answer: ${e.answer}`;
        transcript += '\n';
      }
    }

    if (humanMsgs.length > 0) {
      transcript += '\n--- HUMAN MESSAGES ---\n';
      for (const h of humanMsgs) transcript += `[Human]: ${h.content}\n`;
    }

    // Truncate if too long (keep within ~8k tokens for haiku)
    if (transcript.length > 30000) {
      transcript = transcript.slice(0, 30000) + '\n[...truncated]';
    }

    try {
      const response = await callAnthropic(
        MEMORY_ANALYZER_PROMPT,
        [{ role: 'user', content: transcript }],
        'memory-analyzer',
        800
      );
      return parseArchivalFacts(response);
    } catch (err) {
      log.warn({ sessionId, err: err.message }, 'memory analyzer failed');
      return null;
    }
  }

  /**
   * Parse the structured output from the MemoryAnalyzer.
   */
  function parseArchivalFacts(text) {
    const facts = {};
    const fields = ['ARCHETYPE', 'WINNING_PATTERN', 'FAILURE_MODE', 'NOVEL_FRAMING', 'HUMAN_PIVOT', 'SUMMARY'];
    for (const field of fields) {
      const regex = new RegExp(`${field}:\\s*(.+?)(?:\\n|$)`);
      const match = text.match(regex);
      facts[field.toLowerCase()] = match ? match[1].trim() : null;
    }
    return facts;
  }

  /**
   * Build memory context string to inject into an agent's context.
   * Respects MEMORY_TOKEN_BUDGET.
   */
  function injectMemory(memories) {
    if (!memories || memories.length === 0) return '';

    let text = '=== RELEVANT PRIOR SESSIONS ===\n';
    let tokenCount = estimateTokens(text);

    for (const mem of memories) {
      const entry = `\n--- Prior Session (similarity: ${(mem.similarity * 100).toFixed(0)}%${mem.quality_score ? `, quality: ${mem.quality_score.toFixed(1)}` : ''}) ---\nProblem: ${mem.problem}\n`;

      const entryTokens = estimateTokens(entry);
      if (tokenCount + entryTokens > MEMORY_TOKEN_BUDGET) {
        // Truncate to just the problem statement
        const truncated = `\n[Additional similar session found but omitted due to context budget]\n`;
        text += truncated;
        break;
      }

      // Try to add summary if available
      if (mem.summary) {
        const fullEntry = entry + `Summary: ${mem.summary}\n`;
        const fullTokens = estimateTokens(fullEntry);
        if (tokenCount + fullTokens <= MEMORY_TOKEN_BUDGET) {
          text += fullEntry;
          tokenCount += fullTokens;
          continue;
        }
      }

      text += entry;
      tokenCount += entryTokens;
    }

    text += '\n=== END PRIOR SESSIONS ===\n\n';
    return text;
  }

  /**
   * Bootstrap: embed all existing sessions that don't have embeddings yet.
   */
  async function bootstrap() {
    const sessions = stmts.getSessions.all();
    let embedded = 0;
    let skipped = 0;
    let failed = 0;

    for (const session of sessions) {
      // Check if already embedded
      const existing = stmts.getEmbeddingMetaBySession.all(session.id);
      if (existing.length > 0) {
        skipped++;
        continue;
      }

      const success = await storeSessionMemory(session.id);
      if (success) {
        embedded++;
        // Run archival fact extraction too
        const facts = await extractArchivalFacts(session.id);
        if (facts) {
          log.info({ sessionId: session.id, archetype: facts.archetype || 'unknown' }, 'memory archival facts extracted');
        }
      } else {
        failed++;
      }
    }

    log.info({ embedded, skipped, failed }, 'memory bootstrap complete');
    return { embedded, skipped, failed };
  }

  return {
    storeSessionMemory,
    retrieveSimilar,
    extractArchivalFacts,
    injectMemory,
    bootstrap,
    buildSessionSummary,
  };
}

/**
 * Convenience bootstrap entry point:
 *   node -e "require('./lib/memory').bootstrap()"
 */
function bootstrap() {
  const { db, stmts } = require('../db');
  const { callAnthropic } = require('./llm');
  const { AGENTS } = require('./agents');
  const { PHASES } = require('./phases');
  const mgr = createMemoryManager({ db, stmts, callAnthropic, AGENTS, PHASES });
  return mgr.bootstrap().then(() => { db.close(); });
}

module.exports = { createMemoryManager, bootstrap };
