'use strict';

// Preflight dry run for a model/route change.
//
// Changing which model an agent runs on is a blind write: the panel accepts any
// string, the MCP tool accepts any string, and the first proof that the pair is
// wrong arrives as a failed agent turn in the middle of a deliberation. The
// single-pair probe (test-connection) only covers the pair you happened to
// type, and it only covers a plain completion.
//
// This walks the whole deliberation the way the server will run it — every
// phase, every agent in that phase, plus the support calls that bracket the
// phases (fingerprint, memory, improver, adversarial twin, quality) — resolves
// each one against the CANDIDATE routing rather than the stored one, and fires
// one real minimal completion per distinct (route, model, kind) pair.
//
// Two probe kinds, because the deliberation uses two transports:
//   chat  — plain completion. The support calls take this path.
//   tools — completion with a tools array. EVERY agent turn takes this path
//           (escalate_to_human is always attached, search agents add
//           web_search), so a model that answers a plain prompt but rejects a
//           tools array fails every turn while looking healthy to a chat probe.
//
// Cost is one probe per distinct pair, not one per agent: the common case (all
// agents on one model) is a single round trip.

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONCURRENCY = 6;

// The calls that bracket the phases. None of these are routable agents, so an
// operator who repoints every agent in the panel still leaves these resolving
// through the deployment default — which is exactly how a session reaches
// synthesis and then fails to score itself.
const SUPPORT_CALLS = [
  { id: 'fingerprint-classifier', name: 'Fingerprint classifier', purpose: 'picks the archetype and which specialists to spawn, before framing' },
  { id: 'memory-analyzer', name: 'Memory analyzer', purpose: 'injects lessons from earlier sessions into the opening brief' },
  { id: 'improver', name: 'Problem improver', purpose: 'sharpens the raw problem statement on intake' },
  { id: 'adversarial-twin', name: 'Adversarial twin', purpose: 'writes the shadow synthesis the real one is scored against' },
  { id: 'quality-evaluator', name: 'Quality evaluator', purpose: 'scores the session after synthesis' },
];

function probeKey(route, model, kind) {
  return `${route || '(none)'}|${model || '(none)'}|${kind}`;
}

// Run thunks with a bounded number in flight. A candidate routing that puts 19
// agents on 19 different models would otherwise open 19 sockets at once and
// look like an attack to the gateway.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @param {object} deps
 * @param {Array}  deps.AGENTS          core agent roster
 * @param {Array}  deps.PHASES          [{ id, name, agents: [agentId] }]
 * @param {object} deps.specialist      specialist spawner (listTemplates)
 * @param {func}   deps.resolveRoute    (agentId, explicitModel, routingOverride) -> { route, model, transport }
 * @param {func}   deps.testConnection  ({ route, model, tools, timeoutMs }) -> { ok, latencyMs, error }
 * @param {func}   deps.getSearchConfigForAgent
 * @param {object} deps.log
 */
function createPreflight(deps) {
  const { AGENTS, PHASES, specialist, appConfig, resolveRoute, testConnection, getSearchConfigForAgent, log } = deps;

  function agentMeta(agentId) {
    const core = (AGENTS || []).find(a => a.id === agentId);
    if (core) return { name: core.name, emoji: core.emoji };
    return { name: agentId, emoji: '' };
  }

  function specialistTemplates() {
    try {
      const list = specialist && typeof specialist.listTemplates === 'function' ? specialist.listTemplates() : [];
      return (list || []).filter(t => t && t.id);
    } catch (err) {
      if (log && log.warn) log.warn({ err: err.message }, 'preflight: specialist templates unreadable');
      return [];
    }
  }

  /**
   * Dry-run a candidate routing.
   *
   * @param {object} opts
   * @param {object} opts.routing        candidate { agentId: { route?, model? } }. Omit to dry-run what is stored.
   * @param {number} opts.timeoutMs      per-probe deadline
   * @param {number} opts.concurrency    max probes in flight
   * @returns {Promise<object>} report — always resolves; provider failures are data.
   */
  async function run({ routing = null, timeoutMs = DEFAULT_TIMEOUT_MS, concurrency = DEFAULT_CONCURRENCY } = {}) {
    const started = Date.now();
    const override = routing && typeof routing === 'object' ? routing : null;

    function configuredFor(agentId) {
      if (override) {
        const e = override[agentId];
        return (e && typeof e === 'object') ? e : null;
      }
      return appConfig && typeof appConfig.getAgentRoute === 'function' ? appConfig.getAgentRoute(agentId) : null;
    }

    function makeCheckpoint(agentId, kind, meta) {
      const m = meta || agentMeta(agentId);
      const r = resolveRoute(agentId, undefined, override);
      const searchCfg = typeof getSearchConfigForAgent === 'function' ? getSearchConfigForAgent(agentId) : null;
      const want = configuredFor(agentId);
      return {
        id: agentId,
        name: m.name || agentId,
        emoji: m.emoji || '',
        route: r.route,
        model: r.model,
        transport: r.transport,
        // The operator asked for one route and resolveRoute handed back another
        // (missing credential, or a route with no model). The probe then tests
        // what will really run, and this says the config did not take.
        fellBack: !!(want && want.route && want.route !== r.route),
        requestedRoute: (want && want.route) || null,
        // A search agent sends two tool definitions instead of one. Same
        // transport, same failure mode, so it does not need its own probe —
        // it is surfaced so a failing row explains itself.
        search: !!searchCfg,
        kind,
        ok: null,
        error: null,
        latencyMs: null,
      };
    }

    // 1. Collect every checkpoint the deliberation will hit.
    const checkpoints = [];
    const phases = (PHASES || []).map(p => {
      const agents = (p.agents || []).map(agentId => {
        const cp = makeCheckpoint(agentId, 'tools');
        checkpoints.push(cp);
        return cp;
      });
      return { id: p.id, name: p.name, agents };
    });

    const specialists = specialistTemplates().map(t => {
      const cp = makeCheckpoint(t.id, 'tools', { name: t.name, emoji: t.emoji });
      checkpoints.push(cp);
      return cp;
    });

    const support = SUPPORT_CALLS.map(s => {
      const cp = makeCheckpoint(s.id, 'chat', { name: s.name });
      cp.purpose = s.purpose;
      checkpoints.push(cp);
      return cp;
    });


    // 2. One probe per distinct (route, model, kind). Nothing configured at all
    // is a hard stop before any network call: there is no pair to probe.
    const unconfigured = checkpoints.filter(c => !c.transport);
    const probes = new Map();
    for (const cp of checkpoints) {
      if (!cp.transport) continue;
      const key = probeKey(cp.route, cp.model, cp.kind);
      if (!probes.has(key)) probes.set(key, { key, route: cp.route, model: cp.model, kind: cp.kind, agents: [] });
      probes.get(key).agents.push(cp.id);
    }

    const probeList = [...probes.values()];
    await mapLimit(probeList, concurrency, async (p) => {
      // route 'default' means "the deployment default provider", which
      // testConnection selects with a blank route — passing the literal string
      // would be rejected as an unknown route id.
      const routeArg = p.route === 'default' ? '' : p.route;
      const r = await testConnection({ route: routeArg, model: p.model, tools: p.kind === 'tools', timeoutMs });
      p.ok = !!r.ok;
      p.latencyMs = r.latencyMs != null ? r.latencyMs : null;
      p.error = r.ok ? null : (r.error || 'unknown provider error');
      return p;
    });

    // 3. Fold verdicts back onto every checkpoint. A route that silently fell
    // back is a failure even when the fallback answers: the deliberation would
    // run somewhere the operator did not choose.
    for (const cp of checkpoints) {
      if (!cp.transport) {
        cp.ok = false;
        cp.error = 'no provider configured for this agent — set a route with credentials, or configure the deployment default';
        continue;
      }
      const p = probes.get(probeKey(cp.route, cp.model, cp.kind));
      cp.latencyMs = p.latencyMs;
      if (cp.fellBack) {
        cp.ok = false;
        cp.error = `route ${cp.requestedRoute} has no credentials on this server; this agent would silently run on ${cp.route} instead`;
        continue;
      }
      cp.ok = p.ok;
      cp.error = p.error;
    }

    for (const ph of phases) ph.ok = ph.agents.every(a => a.ok);

    const failures = [];
    for (const ph of phases) {
      for (const a of ph.agents) {
        if (!a.ok) failures.push(`${ph.name} — ${a.name}: ${a.model} via ${a.route || 'no route'} → ${a.error}`);
      }
    }
    for (const s of specialists) {
      if (!s.ok) failures.push(`Specialist — ${s.name}: ${s.model} via ${s.route || 'no route'} → ${s.error}`);
    }
    for (const s of support) {
      if (!s.ok) failures.push(`${s.name} — ${s.model} via ${s.route || 'no route'} → ${s.error}`);
    }

    const ok = failures.length === 0;
    const durationMs = Date.now() - started;
    const slowest = probeList.reduce((n, p) => Math.max(n, p.latencyMs || 0), 0);

    return {
      ok,
      durationMs,
      checkedAt: started,
      probeCount: probeList.length,
      checkpointCount: checkpoints.length,
      slowestProbeMs: slowest,
      phases,
      specialists,
      support,
      probes: probeList.map(p => ({ route: p.route, model: p.model, kind: p.kind, ok: p.ok, latencyMs: p.latencyMs, error: p.error, agents: p.agents })),
      failures,
      unconfigured: unconfigured.map(c => c.id),
      summary: ok
        ? `All ${checkpoints.length} checkpoints across ${phases.length} phases answered. ${probeList.length} provider probe(s), slowest ${slowest}ms.`
        : `${failures.length} of ${checkpoints.length} checkpoints failed. ${failures[0]}`,
    };
  }

  return { run, SUPPORT_CALLS };
}

module.exports = { createPreflight, SUPPORT_CALLS, DEFAULT_TIMEOUT_MS };
