const fs = require('fs');
const path = require('path');

const promptsDir = path.join(__dirname, '..', 'prompts', 'core');

// SCOUT_USE_TOOL flips scout's system prompt to the web_search-tool variant.
// Evaluated at module load so the agent roster is a static snapshot — the
// server is restarted when the flag flips, there is no hot-swap.
const SCOUT_USE_TOOL = String(process.env.SCOUT_USE_TOOL || '').toLowerCase() === 'true';

function loadPrompt(agentId) {
  const file = path.join(promptsDir, `${agentId}.md`);
  return fs.readFileSync(file, 'utf-8').trim();
}

const AGENTS = [
  {
    id: 'process-architect', name: 'Process Architect', emoji: '🎯', color: '#00ff41',
    role: 'Metacognitive Conductor', hat: 'Blue Hat',
    systemPrompt: loadPrompt('process-architect'),
  },
  {
    id: 'systems-synthesizer', name: 'Systems Synthesizer', emoji: '🔗', color: '#00e639',
    role: 'Boundary Spanner', hat: 'Cross-Domain',
    systemPrompt: loadPrompt('systems-synthesizer'),
  },
  {
    id: 'divergent-generator', name: 'Divergent Generator', emoji: '💡', color: '#00cc30',
    role: 'Creative Disruptor', hat: 'Green Hat',
    systemPrompt: loadPrompt('divergent-generator'),
  },
  {
    id: 'convergent-evaluator', name: 'Convergent Evaluator', emoji: '⚖️', color: '#00b328',
    role: 'Analytical Engine', hat: 'Black/White Hat',
    systemPrompt: loadPrompt('convergent-evaluator'),
  },
  {
    id: 'red-teamer', name: 'Red Teamer', emoji: '🔴', color: '#00991f',
    role: 'Adversarial Stress-Tester', hat: "Devil's Advocate",
    systemPrompt: loadPrompt('red-teamer'),
  },
  {
    id: 'quantitative-expert', name: 'Quantitative Expert', emoji: '📐', color: '#008017',
    role: 'Technical Depth', hat: 'STEM',
    systemPrompt: loadPrompt('quantitative-expert'),
  },
  {
    id: 'qualitative-expert', name: 'Qualitative Expert', emoji: '📜', color: '#00660f',
    role: 'Institutional Depth', hat: 'Policy/Business',
    systemPrompt: loadPrompt('qualitative-expert'),
  },
  {
    id: 'research-scout', name: 'Research Scout', emoji: '🔍', color: '#00ff41',
    role: 'Information Architect', hat: 'Intel',
    systemPrompt: loadPrompt(SCOUT_USE_TOOL ? 'research-scout-tool' : 'research-scout'),
  },
];

/**
 * Get the full agent roster for a session (core 8 + any specialists).
 * @param {object} session - Session object with optional _specialists array
 * @returns {object[]} - Combined agent roster
 */
function getAgentsForSession(session) {
  if (!session || !session._specialists || session._specialists.length === 0) {
    return AGENTS;
  }
  return [...AGENTS, ...session._specialists];
}

module.exports = { AGENTS, getAgentsForSession };
