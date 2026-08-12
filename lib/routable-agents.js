'use strict';

// The one list of agents an operator can point at a provider: the core agents
// plus every active specialist template.
//
// Specialists are spawned per session from agent_templates, so they never
// appear in AGENTS. Left out of the routable set they resolve to the
// deployment default forever, and the write that tries to change that is
// accepted and silently discarded (sanitizeRouting drops an unknown id with
// `continue`, not an error). That is how a cooling-down default gateway took
// every specialist turn on 2026-08-11 while the configured provider sat idle.
//
// Three surfaces need this set — the Settings PUT/GET, the in-process MCP
// transport, and the stdio MCP transport (which reads it back off the HTTP
// endpoint). They derived it separately before, which is exactly how they
// drifted, so it lives here and each one calls this.

function routableAgents(AGENTS, specialist, log) {
  const rows = (AGENTS || []).map(a => ({
    id: a.id, name: a.name, emoji: a.emoji, role: a.role, isSpecialist: false,
  }));
  const seen = new Set(rows.map(a => a.id));
  let templates = [];
  try {
    templates = specialist && typeof specialist.listTemplates === 'function' ? specialist.listTemplates() : [];
  } catch (err) {
    if (log && log.warn) log.warn({ err: err.message }, 'specialist templates unreadable; routing list is core agents only');
    templates = [];
  }
  for (const t of templates) {
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push({ id: t.id, name: t.name, emoji: t.emoji, role: t.role, isSpecialist: true });
  }
  return rows;
}

function routableAgentIds(AGENTS, specialist, log) {
  return new Set(routableAgents(AGENTS, specialist, log).map(a => a.id));
}

module.exports = { routableAgents, routableAgentIds };
