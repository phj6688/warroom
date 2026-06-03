const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { countTokens } = require('./tokens');
const { log } = require('./logger');

const QUALITY_EVALUATOR_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'meta', 'quality-evaluator.md'), 'utf-8'
).trim();

const ADVERSARIAL_TWIN_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'meta', 'adversarial-twin.md'), 'utf-8'
).trim();

// Quality score weights from TASKSPEC
const W1 = 0.15; // PhaseCompletionRate
const W2 = 0.20; // EscalationEfficiency
const W3 = 0.35; // SynthesisStructureScore
const W4 = 0.15; // log(1 + CrossSessionRefCount)
const W5 = 0.15; // ShadowDelta

const EPSILON = 0.001;
const TOTAL_PHASES = 5;

/**
 * Initialize quality module with dependencies.
 */
function createQualityManager(deps) {
  const { db, stmts, callAnthropic, PHASES, onTokenUsage } = deps;
  // HLB-152 — attribute quality-scoring tokens to the session under evaluation.
  const recordUsage = (sessionId, usage) => {
    if (typeof onTokenUsage === 'function') onTokenUsage(sessionId, 'quality', usage);
  };

  /**
   * Generate shadow (adversarial twin) answer for a problem.
   * Async, non-blocking — called at session creation.
   */
  async function generateShadowAnswer(sessionId, problem) {
    if (!problem || problem.trim().length < 20) {
      log.info({ sessionId }, 'quality: skipping shadow — problem too short');
      return null;
    }

    try {
      const answer = await callAnthropic(
        ADVERSARIAL_TWIN_PROMPT,
        [{ role: 'user', content: problem }],
        'adversarial-twin',
        1500,
        (u) => recordUsage(sessionId, u)
      );
      stmts.updateSessionShadowAnswer.run(answer, Date.now(), sessionId);
      log.info({ sessionId, tokens: countTokens(answer) }, 'quality: shadow answer generated');
      return answer;
    } catch (err) {
      log.warn({ sessionId, err: err.message }, 'quality: shadow generation failed');
      return null;
    }
  }

  /**
   * Compute PhaseCompletionRate: phases_with_messages / total_phases
   */
  function computePhaseCompletion(sessionId) {
    const messages = stmts.getSessionMessages.all(sessionId);
    const phaseNames = new Set(messages.map(m => m.phase));
    return phaseNames.size / TOTAL_PHASES;
  }

  /**
   * Compute EscalationEfficiency: answered / total (1.0 if none asked)
   */
  function computeEscalationEfficiency(sessionId) {
    const escalations = stmts.getSessionEscalations.all(sessionId);
    if (escalations.length === 0) return 1.0;
    const answered = escalations.filter(e => e.status === 'answered').length;
    return answered / escalations.length;
  }

  /**
   * Compute SynthesisStructureScore via LLM evaluation.
   */
  async function computeSynthesisStructureScore(sessionId) {
    const messages = stmts.getSessionMessages.all(sessionId);
    const synthesis = messages.filter(m => m.phase === 'Synthesis');

    if (synthesis.length === 0) return 0.0;

    const synthesisText = synthesis.map(m => m.content).join('\n\n');

    // Truncate if too long for haiku
    const truncated = synthesisText.length > 15000
      ? synthesisText.slice(0, 15000) + '\n[...truncated]'
      : synthesisText;

    try {
      const response = await callAnthropic(
        QUALITY_EVALUATOR_PROMPT,
        [{ role: 'user', content: `Evaluate this synthesis:\n\n${truncated}` }],
        'quality-evaluator',
        300,
        (u) => recordUsage(sessionId, u)
      );
      return parseStructureScore(response);
    } catch (err) {
      log.warn({ sessionId, err: err.message }, 'quality: structure scoring failed');
      return 0.5; // default mid-score on failure
    }
  }

  /**
   * Parse the QualityEvaluator's structured output.
   */
  function parseStructureScore(text) {
    const match = text.match(/STRUCTURE_SCORE:\s*([\d.]+)/);
    if (match) {
      const score = parseFloat(match[1]);
      if (!isNaN(score) && score >= 0 && score <= 1) return score;
    }
    // Fallback: average the component scores
    const components = ['RECOMMENDATIONS', 'CONFIDENCE_LEVELS', 'DISSENTING_VIEWS', 'NEXT_STEPS'];
    let sum = 0;
    let count = 0;
    for (const comp of components) {
      const m = text.match(new RegExp(`${comp}:\\s*([\\d.]+)`));
      if (m) {
        const v = parseFloat(m[1]);
        if (!isNaN(v) && v >= 0 && v <= 1) { sum += v; count++; }
      }
    }
    return count > 0 ? sum / count : 0.5;
  }

  /**
   * Compute CrossSessionRefCount: how many other sessions retrieved this one from memory.
   */
  function computeCrossRefCount(sessionId) {
    // Count embedding_meta entries that reference other sessions which were
    // retrieved when this session's embedding was a KNN match.
    // For now, we approximate by checking how many sessions have memory_injected=1
    // and were created after this session. The actual ref count grows organically.
    // A more precise count would require a retrieval_log table.
    const session = stmts.getSession.get(sessionId);
    if (!session) return 0;

    // Count sessions created after this one that have memory injected
    const count = db.prepare(
      'SELECT COUNT(*) as c FROM sessions WHERE memory_injected = 1 AND created_at > ? AND id != ?'
    ).get(session.created_at, sessionId).c;

    return Math.min(count, 10); // Cap at 10 for normalization
  }

  /**
   * Compute ShadowDelta: evaluate shadow answer with same criteria,
   * then return synthesis_score - shadow_score.
   */
  async function computeShadowDelta(sessionId) {
    const session = stmts.getSession.get(sessionId);
    if (!session || !session.shadow_answer) return null;

    try {
      const response = await callAnthropic(
        QUALITY_EVALUATOR_PROMPT,
        [{ role: 'user', content: `Evaluate this synthesis:\n\n${session.shadow_answer}` }],
        'quality-evaluator',
        300,
        (u) => recordUsage(sessionId, u)
      );
      const shadowScore = parseStructureScore(response);
      return shadowScore;
    } catch (err) {
      log.warn({ sessionId, err: err.message }, 'quality: shadow delta scoring failed');
      return null;
    }
  }

  /**
   * Compute composite quality score using TASKSPEC formula.
   * If ShadowDelta is null, reweight remaining components.
   */
  function computeComposite(components) {
    const { phaseCompletion, escalationEfficiency, structureScore, crossRefCount, shadowDelta } = components;

    // Normalize crossRefCount: log(1 + count) / log(1 + 10) to get 0-1 range
    const normalizedRef = Math.log(1 + crossRefCount) / Math.log(1 + 10);

    if (shadowDelta === null || shadowDelta === undefined) {
      // Reweight without shadow delta
      const totalWeight = W1 + W2 + W3 + W4;
      return (
        (W1 / totalWeight) * phaseCompletion +
        (W2 / totalWeight) * escalationEfficiency +
        (W3 / totalWeight) * structureScore +
        (W4 / totalWeight) * normalizedRef
      );
    }

    // ShadowDelta: structureScore - shadowStructureScore, clamped to [0, 1]
    const normalizedDelta = Math.max(0, Math.min(1, (shadowDelta + 1) / 2));

    return (
      W1 * phaseCompletion +
      W2 * escalationEfficiency +
      W3 * structureScore +
      W4 * normalizedRef +
      W5 * normalizedDelta
    );
  }

  /**
   * Full quality evaluation for a session.
   * Called after deliberation-complete.
   */
  async function evaluateSession(sessionId) {
    const session = stmts.getSession.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Check if already evaluated (idempotent)
    const existing = db.prepare('SELECT id FROM quality_scores WHERE session_id = ?').get(sessionId);
    if (existing) {
      log.info({ sessionId }, 'quality: session already evaluated, skipping');
      return getQualityScore(sessionId);
    }

    log.info({ sessionId }, 'quality: evaluating session');

    const phaseCompletion = computePhaseCompletion(sessionId);
    const escalationEfficiency = computeEscalationEfficiency(sessionId);
    const structureScore = await computeSynthesisStructureScore(sessionId);
    const crossRefCount = computeCrossRefCount(sessionId);

    // Shadow delta: compare synthesis structure vs shadow structure
    let shadowDelta = null;
    const shadowStructureScore = await computeShadowDelta(sessionId);
    if (shadowStructureScore !== null) {
      shadowDelta = structureScore - shadowStructureScore;
    }

    const composite = computeComposite({
      phaseCompletion, escalationEfficiency, structureScore, crossRefCount, shadowDelta
    });

    // Clamp to [0, 1]
    const finalScore = Math.max(0, Math.min(1, composite));

    const model = process.env.QUALITY_MODEL || process.env.MODEL || 'unknown';

    // Store in quality_scores table
    const id = crypto.randomUUID();
    stmts.insertQualityScore.run(
      id, sessionId,
      phaseCompletion, escalationEfficiency, structureScore,
      crossRefCount, shadowDelta, finalScore, model, Date.now()
    );

    // Update sessions.quality_score
    stmts.updateSessionQualityScore.run(finalScore, Date.now(), sessionId);

    log.info({
      sessionId,
      score: finalScore,
      phaseCompletion,
      escalationEfficiency,
      structureScore,
      crossRefCount,
      shadowDelta,
    }, 'quality: session scored');

    return {
      score: finalScore,
      breakdown: {
        phase_completion_rate: phaseCompletion,
        escalation_efficiency: escalationEfficiency,
        synthesis_structure_score: structureScore,
        cross_ref_count: crossRefCount,
        shadow_delta: shadowDelta,
      },
      evaluator_model: model,
    };
  }

  /**
   * Get quality score for a session (from DB).
   */
  function getQualityScore(sessionId) {
    const row = stmts.getQualityScore.get(sessionId);
    if (!row) return null;
    return {
      score: row.composite_score,
      breakdown: {
        phase_completion_rate: row.phase_completion_rate,
        escalation_efficiency: row.escalation_efficiency,
        synthesis_structure_score: row.synthesis_structure_score,
        cross_ref_count: row.cross_ref_count,
        shadow_delta: row.shadow_delta,
      },
      evaluator_model: row.evaluator_model,
      created_at: row.created_at,
    };
  }

  /**
   * Get quality analytics across all scored sessions.
   */
  function getAnalytics() {
    const rows = db.prepare(
      'SELECT composite_score, phase_completion_rate, escalation_efficiency, synthesis_structure_score, cross_ref_count, shadow_delta, created_at FROM quality_scores ORDER BY created_at ASC'
    ).all();

    if (rows.length === 0) {
      return { avg: null, count: 0, trend: [], topSessions: [], bottomSessions: [] };
    }

    const scores = rows.map(r => r.composite_score);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;

    // Trend: rolling average over last 5
    const trend = [];
    for (let i = 0; i < scores.length; i++) {
      const window = scores.slice(Math.max(0, i - 4), i + 1);
      trend.push({
        index: i,
        score: scores[i],
        rolling_avg: window.reduce((a, b) => a + b, 0) / window.length,
      });
    }

    // Top and bottom sessions
    const scored = db.prepare(
      'SELECT q.session_id, q.composite_score, s.problem FROM quality_scores q JOIN sessions s ON s.id = q.session_id ORDER BY q.composite_score DESC'
    ).all();

    const topSessions = scored.slice(0, 5).map(r => ({
      session_id: r.session_id, score: r.composite_score, problem: r.problem,
    }));
    const bottomSessions = scored.slice(-5).reverse().map(r => ({
      session_id: r.session_id, score: r.composite_score, problem: r.problem,
    }));

    return {
      avg,
      count: rows.length,
      trend,
      topSessions,
      bottomSessions,
      breakdown_avg: {
        phase_completion_rate: rows.reduce((a, r) => a + r.phase_completion_rate, 0) / rows.length,
        escalation_efficiency: rows.reduce((a, r) => a + r.escalation_efficiency, 0) / rows.length,
        synthesis_structure_score: rows.reduce((a, r) => a + r.synthesis_structure_score, 0) / rows.length,
        cross_ref_count: rows.reduce((a, r) => a + r.cross_ref_count, 0) / rows.length,
      },
    };
  }

  /**
   * Retroactively score all existing sessions that don't have quality scores.
   * Idempotent — safe to run multiple times.
   */
  async function retroactiveScore() {
    const sessions = db.prepare(
      "SELECT id FROM sessions WHERE active = 0 AND id NOT IN (SELECT session_id FROM quality_scores)"
    ).all();

    if (sessions.length === 0) {
      log.info('quality: no sessions need retroactive scoring');
      return { scored: 0, failed: 0 };
    }

    log.info({ count: sessions.length }, 'quality: retroactively scoring sessions');
    let scored = 0;
    let failed = 0;

    for (const { id } of sessions) {
      try {
        await evaluateSession(id);
        scored++;
      } catch (err) {
        log.warn({ sessionId: id, err: err.message }, 'quality: retroactive scoring failed');
        failed++;
      }
    }

    log.info({ scored, failed }, 'quality: retroactive scoring complete');
    return { scored, failed };
  }

  return {
    generateShadowAnswer,
    evaluateSession,
    computeShadowDelta,
    getQualityScore,
    getAnalytics,
    retroactiveScore,
  };
}

module.exports = { createQualityManager };
