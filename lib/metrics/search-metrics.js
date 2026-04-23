// S6 — search_metrics sink. Single-writer, synchronous. One prepared
// INSERT statement is shared across event_types; the caller fills the
// columns that apply to the event and leaves the rest null. Keeping one
// statement means one SQL parse, no dispatch table, and a stable row
// shape that's easy to query from canary-views.
//
// Agent tier is derived here (not at the call site) so every new
// event_type gets consistent tier stamping. Unknown agent ids map to 'D'
// — matches the Session 5 roster rule that ambiguous agents default to
// no-search / tier D. Real tier-D turns still emit `agent_turn_complete`
// rows with path='none' for turn-volume denominator accuracy.

'use strict';

const { AGENT_SEARCH_CONFIG } = require('../agents/search-config');

const EVENT_TYPES = Object.freeze({
  AGENT_TURN_COMPLETE: 'agent_turn_complete',
  TOOL_CALL: 'tool_call',
  BUDGET_TRUNCATION: 'budget_truncation',
  SESSION_BUDGET_EXHAUSTED: 'session_budget_exhausted',
  HANDLER_ERROR: 'handler_error',
});

const VALID_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));
const VALID_PATHS = new Set(['tool_use', 'prose_marker', 'none']);
const VALID_TIERS = new Set(['A', 'B', 'C', 'D']);

function tierForAgent(agentId) {
  const cfg = AGENT_SEARCH_CONFIG[agentId];
  return cfg && VALID_TIERS.has(cfg.tier) ? cfg.tier : 'D';
}

function createMetricsSink(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createMetricsSink: db must be a better-sqlite3 instance');
  }

  const insert = db.prepare(`
    INSERT INTO search_metrics (
      session_id, agent_id, agent_tier, path, event_type,
      rounds_used, queries_emitted, queries_executed, truncated,
      budget_exhausted_terminal, synthesis_chars, latency_ms,
      error, provider, created_at
    ) VALUES (
      @session_id, @agent_id, @agent_tier, @path, @event_type,
      @rounds_used, @queries_emitted, @queries_executed, @truncated,
      @budget_exhausted_terminal, @synthesis_chars, @latency_ms,
      @error, @provider, @created_at
    )
  `);

  function toBool(v) {
    if (v === undefined || v === null) return null;
    return v ? 1 : 0;
  }

  function record(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('record: event must be an object');
    }
    const eventType = event.eventType;
    if (!VALID_EVENT_TYPES.has(eventType)) {
      throw new Error(`record: unknown event_type "${eventType}"`);
    }
    const sessionId = event.sessionId;
    const agentId = event.agentId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('record: sessionId required');
    if (typeof agentId !== 'string' || !agentId) throw new Error('record: agentId required');

    const path = event.path != null ? event.path : 'none';
    if (!VALID_PATHS.has(path)) {
      throw new Error(`record: invalid path "${path}"`);
    }

    const tier = event.agentTier || tierForAgent(agentId);
    if (!VALID_TIERS.has(tier)) {
      throw new Error(`record: invalid agent_tier "${tier}"`);
    }

    const row = {
      session_id: sessionId,
      agent_id: agentId,
      agent_tier: tier,
      path,
      event_type: eventType,
      rounds_used: Number.isFinite(event.roundsUsed) ? event.roundsUsed : null,
      queries_emitted: Number.isFinite(event.queriesEmitted) ? event.queriesEmitted : null,
      queries_executed: Number.isFinite(event.queriesExecuted) ? event.queriesExecuted : null,
      truncated: toBool(event.truncated),
      budget_exhausted_terminal: toBool(event.budgetExhaustedTerminal),
      synthesis_chars: Number.isFinite(event.synthesisChars) ? event.synthesisChars : null,
      latency_ms: Number.isFinite(event.latencyMs) ? event.latencyMs : null,
      error: event.error != null ? String(event.error) : null,
      provider: event.provider != null ? String(event.provider) : null,
      created_at: Number.isFinite(event.createdAt) ? event.createdAt : Date.now(),
    };

    const info = insert.run(row);
    return info.lastInsertRowid;
  }

  return { record };
}

// No-op sink. Useful when the host process doesn't want to plumb metrics
// through (ad-hoc scripts, MCP stdio) but still calls a code path that
// expects a `.record()` method.
function createNullMetricsSink() {
  return { record() { /* no-op */ } };
}

module.exports = {
  createMetricsSink,
  createNullMetricsSink,
  tierForAgent,
  EVENT_TYPES,
};
