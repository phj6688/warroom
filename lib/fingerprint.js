const fs = require('fs');
const path = require('path');

const CLASSIFIER_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'meta', 'fingerprint-classifier.md'), 'utf-8'
).trim();

const MIN_CONFIDENCE = 0.7;

/**
 * Initialize fingerprint classifier with dependencies.
 */
function createFingerprintClassifier(deps) {
  const { callAnthropic } = deps;

  /**
   * Classify a problem statement into an archetype with specialist recommendations.
   * Must complete in < 3 seconds (uses haiku-class model).
   */
  async function classify(problem) {
    if (!problem || problem.trim().length < 20) {
      return { archetype: null, confidence: 0, recommendedSpecialists: [], reasoning: 'Problem too short' };
    }

    try {
      const response = await callAnthropic(
        CLASSIFIER_PROMPT,
        [{ role: 'user', content: problem.slice(0, 5000) }],
        'fingerprint-classifier',
        200
      );
      return parseClassification(response);
    } catch (err) {
      console.warn(`[fingerprint] Classification failed: ${err.message}`);
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

  return { classify, MIN_CONFIDENCE };
}

module.exports = { createFingerprintClassifier };
