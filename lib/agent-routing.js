'use strict';

// Shared validation for the agent_routing setting, used by both the Settings
// HTTP PUT and the MCP model tools. The two callers must never drift: the
// "non-default route requires a model" rule is what stops resolveRoute() from
// shipping the global Anthropic model id to an OpenAI-compatible endpoint, and
// a copy of that rule in one caller only is a bypass waiting to happen.

const MAX_MODEL_LEN = 200;

// Normalize one { route?, model? } entry. Returns { entry } or { error }.
// A blank/whitespace-only model counts as absent so "   " cannot slip past the
// non-default-route guard as an empty model id.
function validateEntry(agentId, cfg, routes) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { error: `agent ${agentId}: routing entry must be an object` };
  }
  const entry = {};
  if (cfg.route != null && cfg.route !== '') {
    if (!routes.includes(cfg.route)) return { error: `unknown route: ${cfg.route}` };
    entry.route = cfg.route;
  }
  if (cfg.model != null) {
    if (typeof cfg.model !== 'string') return { error: 'model must be a string under 200 chars' };
    const model = cfg.model.trim();
    if (model.length > MAX_MODEL_LEN) return { error: 'model must be a string under 200 chars' };
    if (model) entry.model = model;
  }
  if (entry.route && !entry.model) {
    return { error: `agent ${agentId}: a non-default route requires an explicit model` };
  }
  return { entry };
}

// Sanitize a whole { agentId: { route?, model? } } map. Unknown agent ids and
// entries that normalize to nothing are dropped, so an agent reverts to the env
// default rather than persisting a meaningless row.
function sanitizeRouting(routing, validIds, routes) {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) {
    return { error: 'routing must be an object of { agentId: { route?, model? } }' };
  }
  const clean = {};
  for (const [agentId, cfg] of Object.entries(routing)) {
    if (!validIds.has(agentId)) continue;
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const { entry, error } = validateEntry(agentId, cfg, routes);
    if (error) return { error };
    if (Object.keys(entry).length) clean[agentId] = entry;
  }
  return { clean };
}

// Merge a per-agent change into the existing map instead of replacing it. The
// HTTP PUT sends the whole map because the panel renders every row; an MCP
// caller sets one agent at a time and must not silently wipe the others.
// A null/empty patch entry clears that agent back to the env default.
function mergeRouting(current, patch, validIds, routes) {
  const base = (current && typeof current === 'object' && !Array.isArray(current)) ? { ...current } : {};
  for (const [agentId, cfg] of Object.entries(patch || {})) {
    if (!validIds.has(agentId)) return { error: `unknown agent: ${agentId}` };
    if (cfg == null) { delete base[agentId]; continue; }
    const { entry, error } = validateEntry(agentId, cfg, routes);
    if (error) return { error };
    if (Object.keys(entry).length) base[agentId] = entry;
    else delete base[agentId];
  }
  return { clean: base };
}

module.exports = { validateEntry, sanitizeRouting, mergeRouting, MAX_MODEL_LEN };
