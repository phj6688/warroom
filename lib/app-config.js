'use strict';

// HLB-336 — runtime settings cache. Backs per-agent model+provider routing
// (key 'agent_routing') and, later (HLB-337), pricing/electricity parameters.
// Loaded once at boot from the app_settings table; set() writes through to the
// DB and refreshes the cache, so the operator's Settings-panel edits apply
// without a restart. Statements are injected (no direct DB import) so this stays
// unit-testable and free of an import cycle with lib/llm.js.

// The provider routes an agent's calls can target. Each maps to a transport
// (anthropic SDK, or an OpenAI-compatible HTTP gateway) plus a base URL and
// credential resolved from env in lib/llm.js. The operator-personal Nexus
// gateway is intentionally absent: this app is public and must never default to
// it.
const ROUTES = ['anthropic-api', 'openai-api', 'openrouter', 'subscription', 'ollama-local'];

let _stmts = null;
const _cache = new Map();

function init(stmts) {
  _stmts = stmts;
  _cache.clear();
  try {
    for (const row of stmts.getAllSettings.all()) {
      try { _cache.set(row.key, JSON.parse(row.value)); } catch { /* skip a corrupt row */ }
    }
  } catch (_) {
    // A partially-migrated DB without app_settings is treated as empty, so
    // resolveRoute() falls back to env defaults rather than throwing at boot.
  }
}

function get(key, fallback = null) {
  return _cache.has(key) ? _cache.get(key) : fallback;
}

function set(key, value) {
  _cache.set(key, value);
  if (_stmts) _stmts.upsertSetting.run(key, JSON.stringify(value), Date.now());
  return value;
}

// agent_routing shape: { [agentId]: { route, model } }. A missing agent (or a
// missing field) means "use the env-derived default", so an untouched install
// behaves exactly as before.
function getAgentRouting() {
  const v = get('agent_routing', {});
  return (v && typeof v === 'object') ? v : {};
}

function getAgentRoute(agentId) {
  const r = getAgentRouting()[agentId];
  return (r && typeof r === 'object') ? r : null;
}

module.exports = { ROUTES, init, get, set, getAgentRouting, getAgentRoute };
