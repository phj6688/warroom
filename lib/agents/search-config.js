'use strict';

const fs = require('fs');
const path = require('path');

const FRAGMENT_PATH = path.join(__dirname, '..', '..', 'prompts', 'fragments', 'web-search-capability.md');

const SCOUT_USE_TOOL = String(process.env.SCOUT_USE_TOOL || '').toLowerCase() === 'true';
const AGENT_SEARCH_EXPANSION = String(process.env.AGENT_SEARCH_EXPANSION || '').toLowerCase() === 'true';

const SESSION_QUERY_BUDGET = (() => {
  const raw = parseInt(process.env.SESSION_QUERY_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
})();

// Authoritative tier classification. See forge/session-5-expansion/ROSTER.md
// for justifications. `enabled` is the effective flag: scout toggles with
// SCOUT_USE_TOOL, tiers B and C toggle with AGENT_SEARCH_EXPANSION. Flags are
// evaluated at module load; server restart is required to flip.
const AGENT_SEARCH_CONFIG = Object.freeze({
  'research-scout':       { tier: 'A', maxQueries: 5, maxRounds: 3, enabled: SCOUT_USE_TOOL },
  'red-teamer':           { tier: 'B', maxQueries: 3, maxRounds: 2, enabled: AGENT_SEARCH_EXPANSION },
  'quantitative-expert':  { tier: 'B', maxQueries: 3, maxRounds: 2, enabled: AGENT_SEARCH_EXPANSION },
  'specialist-legal':     { tier: 'C', maxQueries: 2, maxRounds: 1, enabled: AGENT_SEARCH_EXPANSION },
  'specialist-medical':   { tier: 'C', maxQueries: 2, maxRounds: 1, enabled: AGENT_SEARCH_EXPANSION },
  'specialist-financial': { tier: 'C', maxQueries: 2, maxRounds: 1, enabled: AGENT_SEARCH_EXPANSION },
  'specialist-security':  { tier: 'C', maxQueries: 2, maxRounds: 1, enabled: AGENT_SEARCH_EXPANSION },
  'specialist-policy':    { tier: 'C', maxQueries: 2, maxRounds: 1, enabled: AGENT_SEARCH_EXPANSION },
});

function getSearchConfigForAgent(agentId) {
  const cfg = AGENT_SEARCH_CONFIG[agentId];
  if (!cfg) return null;
  return cfg.enabled ? cfg : null;
}

let _fragmentCache = null;
function readFragment() {
  if (_fragmentCache == null) {
    _fragmentCache = fs.readFileSync(FRAGMENT_PATH, 'utf-8').trim();
  }
  return _fragmentCache;
}

function appendSearchFragment(systemPrompt, config) {
  if (!config || !config.enabled) return systemPrompt;
  const fragment = readFragment()
    .replace(/\{\{MAX_QUERIES\}\}/g, String(config.maxQueries))
    .replace(/\{\{MAX_ROUNDS\}\}/g, String(config.maxRounds));
  return `${systemPrompt.trim()}\n\n${fragment}`;
}

function makeSessionBudget(total) {
  const cap = Number.isFinite(total) && total >= 0 ? total : SESSION_QUERY_BUDGET;
  let remaining = cap;
  let consumed = 0;
  return {
    get total() { return cap; },
    get remaining() { return remaining; },
    get consumed() { return consumed; },
    consume(n) {
      const amt = Math.max(0, Math.min(remaining, n || 0));
      remaining -= amt;
      consumed += amt;
      return amt;
    },
  };
}

module.exports = {
  AGENT_SEARCH_CONFIG,
  SESSION_QUERY_BUDGET,
  SCOUT_USE_TOOL,
  AGENT_SEARCH_EXPANSION,
  getSearchConfigForAgent,
  appendSearchFragment,
  makeSessionBudget,
};
