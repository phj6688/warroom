const fs = require('fs');
const path = require('path');
const { getSearchConfigForAgent, appendSearchFragment } = require('./agents/search-config');

const promptsDir = path.join(__dirname, '..', 'prompts', 'core');

// SCOUT_USE_TOOL flips scout's system prompt to the web_search-tool variant.
// Evaluated at module load so the agent roster is a static snapshot — the
// server is restarted when the flag flips, there is no hot-swap.
const SCOUT_USE_TOOL = String(process.env.SCOUT_USE_TOOL || '').toLowerCase() === 'true';

function loadPrompt(agentId) {
  const file = path.join(promptsDir, `${agentId}.md`);
  return fs.readFileSync(file, 'utf-8').trim();
}

// Scout keeps its bespoke tool-variant prompt (shipped in Session 4). Every
// other search-enabled agent gets the shared fragment appended. Scout's
// -tool.md already explains the tool in the role-specific language the
// fragment intentionally keeps generic.
function buildSystemPrompt(agentId) {
  if (agentId === 'research-scout') {
    return loadPrompt(SCOUT_USE_TOOL ? 'research-scout-tool' : 'research-scout');
  }
  const base = loadPrompt(agentId);
  const cfg = getSearchConfigForAgent(agentId);
  return appendSearchFragment(base, cfg);
}

const AGENTS = [
  {
    id: 'process-architect', name: 'Process Architect', emoji: '🎯', color: '#00ff41',
    role: 'Metacognitive Conductor', hat: 'Blue Hat',
    systemPrompt: buildSystemPrompt('process-architect'),
  },
  {
    id: 'systems-synthesizer', name: 'Systems Synthesizer', emoji: '🔗', color: '#00e639',
    role: 'Boundary Spanner', hat: 'Cross-Domain',
    systemPrompt: buildSystemPrompt('systems-synthesizer'),
  },
  {
    id: 'divergent-generator', name: 'Divergent Generator', emoji: '💡', color: '#00cc30',
    role: 'Creative Disruptor', hat: 'Green Hat',
    systemPrompt: buildSystemPrompt('divergent-generator'),
  },
  {
    id: 'convergent-evaluator', name: 'Convergent Evaluator', emoji: '⚖️', color: '#00b328',
    role: 'Analytical Engine', hat: 'Black/White Hat',
    systemPrompt: buildSystemPrompt('convergent-evaluator'),
  },
  {
    id: 'red-teamer', name: 'Red Teamer', emoji: '🔴', color: '#00991f',
    role: 'Adversarial Stress-Tester', hat: "Devil's Advocate",
    systemPrompt: buildSystemPrompt('red-teamer'),
  },
  {
    id: 'quantitative-expert', name: 'Quantitative Expert', emoji: '📐', color: '#008017',
    role: 'Technical Depth', hat: 'STEM',
    systemPrompt: buildSystemPrompt('quantitative-expert'),
  },
  {
    id: 'qualitative-expert', name: 'Qualitative Expert', emoji: '📜', color: '#00660f',
    role: 'Institutional Depth', hat: 'Policy/Business',
    systemPrompt: buildSystemPrompt('qualitative-expert'),
  },
  {
    id: 'research-scout', name: 'Research Scout', emoji: '🔍', color: '#00ff41',
    role: 'Information Architect', hat: 'Intel',
    systemPrompt: buildSystemPrompt('research-scout'),
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
