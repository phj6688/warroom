const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const CLASSIFIER_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'meta', 'fingerprint-classifier.md'), 'utf-8'
).trim();

const MIN_CONFIDENCE = 0.7;

/**
 * Initialize fingerprint classifier with dependencies.
 */
function createFingerprintClassifier(deps) {
  const { callAnthropic, db, stmts } = deps;

  /**
   * Classify a problem statement into an archetype with specialist recommendations.
   * Must complete in < 3 seconds (uses haiku-class model).
   *
   * The user message inlines the output rubric on top of the system prompt.
   * Some gateway-fronted models (e.g. the homelab OpenAI-compatibleAPI gateway) ignore
   * compact system prompts and respond with free-form prose, which makes
   * parseClassification return null. Repeating the rubric in the user turn
   * is the cheap fix that survives both behaviours.
   */
  async function classify(problem) {
    if (!problem || problem.trim().length < 20) {
      return { archetype: null, confidence: 0, recommendedSpecialists: [], reasoning: 'Problem too short' };
    }

    const userContent =
      'PROBLEM STATEMENT:\n' + problem.slice(0, 5000) +
      '\n\nReturn ONLY the four labelled lines (ARCHETYPE, CONFIDENCE, SPECIALISTS, REASONING). No other text, no preamble, no markdown.';

    try {
      const response = await callAnthropic(
        CLASSIFIER_PROMPT,
        [{ role: 'user', content: userContent }],
        'fingerprint-classifier',
        200
      );
      return parseClassification(response);
    } catch (err) {
      log.warn({ err: err.message }, 'fingerprint classification failed');
      return { archetype: null, confidence: 0, recommendedSpecialists: [], reasoning: 'Classification failed' };
    }
  }

  function parseClassification(text) {
    const result = { archetype: null, confidence: 0, recommendedSpecialists: [], reasoning: '' };

    const archMatch = text.match(/ARCHETYPE:\s*(.+?)(?:\n|$)/);
    if (archMatch) result.archetype = archMatch[1].trim();

    const confMatch = text.match(/CONFIDENCE:\s*([\d.]+)/);
    if (confMatch) result.confidence = parseFloat(confMatch[1]) || 0;

    const specMatch = text.match(/SPECIALISTS:\s*(.+?)(?:\n|$)/);
    if (specMatch) {
      const val = specMatch[1].trim().toLowerCase();
      if (val !== 'none' && val !== '') {
        result.recommendedSpecialists = val.split(',').map(s => s.trim()).filter(Boolean).slice(0, 3);
      }
    }

    const reasonMatch = text.match(/REASONING:\s*(.+?)(?:\n|$)/);
    if (reasonMatch) result.reasoning = reasonMatch[1].trim();

    return result;
  }

  // Boot-time backfill: any completed session (phase >= 1) with a substantial
  // problem statement but no archetype gets classified once. Pre-fingerprint
  // sessions and ones whose original classification call failed end up here.
  // Runs serialised with a small delay so it does not blow the LLM rate limit
  // on a homelab gateway.
  async function backfillArchetypes({ delayMs = 500 } = {}) {
    if (!db || !stmts) return { scanned: 0, classified: 0, skipped: 0 };
    const rows = db.prepare(`
      SELECT id, problem FROM sessions
      WHERE archetype_id IS NULL
        AND problem IS NOT NULL
        AND length(problem) >= 20
        AND phase >= 1
      ORDER BY created_at DESC
    `).all();

    let classified = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const result = await classify(row.problem);
        if (result.archetype && result.confidence >= MIN_CONFIDENCE) {
          const now = Date.now();
          stmts.updateSessionArchetype.run(result.archetype, now, row.id);
          stmts.insertArchetype.run(result.archetype, result.archetype, result.reasoning || '', now, now);
          stmts.insertSessionArchetype.run(row.id, result.archetype, result.confidence);
          classified++;
          log.info({ sessionId: row.id, archetype: result.archetype, confidence: result.confidence }, 'archetype backfilled');
        } else {
          skipped++;
        }
      } catch (err) {
        log.warn({ sessionId: row.id, err: err.message }, 'archetype backfill failed for session');
        skipped++;
      }
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    if (rows.length > 0) {
      log.info({ scanned: rows.length, classified, skipped }, 'archetype backfill complete');
    }
    return { scanned: rows.length, classified, skipped };
  }

  return { classify, MIN_CONFIDENCE, backfillArchetypes };
}

module.exports = { createFingerprintClassifier };
