// S6 — canary views over search_metrics. Pure SQL aggregation, no LLM,
// no business logic. Every function accepts a better-sqlite3 db and
// returns a plain object or array of objects the report CLI renders.
//
// Windowing: every view accepts `sinceMs` (unix ms). When null/omitted
// the view aggregates over all history — useful for single-session
// smoke tests that seed a few rows and read them back immediately.
//
// Empty DB semantics: a view returns numeric zeros (not nulls, not
// throws) when no rows match. The CLI can then print "0.0%" uniformly.

'use strict';

function sinceClause(sinceMs) {
  if (sinceMs == null || !Number.isFinite(sinceMs)) return { sql: '', params: {} };
  return { sql: ' AND created_at >= @sinceMs', params: { sinceMs } };
}

function toolUseEmissionRate(db, { agentId, sinceMs } = {}) {
  if (!agentId) throw new Error('toolUseEmissionRate: agentId required');
  const w = sinceClause(sinceMs);

  // Denominator: agent_turn_complete rows for this agent on path='tool_use'.
  const turns = db.prepare(`
    SELECT COUNT(*) AS c FROM search_metrics
    WHERE event_type = 'agent_turn_complete'
      AND agent_id = @agentId
      AND path = 'tool_use'
    ${w.sql}
  `).get({ agentId, ...w.params }).c;

  // Numerator: turns that had at least one tool_call. Grouped by
  // session_id + created_at bucket isn't reliable; tool_call rows land
  // BEFORE the turn row, so we correlate by session_id + agent_id and a
  // small bounding window. Simpler: a turn had search iff at least one
  // tool_call row exists for (agent_id, session_id) created before the
  // agent_turn_complete row AND after the prior turn's complete row.
  //
  // For canary purposes we collapse to: sessions × agent_id where the
  // agent has ≥1 tool_call AND ≥1 agent_turn_complete. This slightly
  // over-attributes when an agent speaks twice in the same session but
  // only searched in one of those turns. Acceptable for aggregate rate;
  // sampleTurns() is the escape hatch for per-turn truth.
  const turnsWithSearch = db.prepare(`
    SELECT COUNT(DISTINCT atc.id) AS c FROM search_metrics atc
    WHERE atc.event_type = 'agent_turn_complete'
      AND atc.agent_id = @agentId
      AND atc.path = 'tool_use'
      ${w.sql}
      AND EXISTS (
        SELECT 1 FROM search_metrics tc
        WHERE tc.event_type = 'tool_call'
          AND tc.agent_id = atc.agent_id
          AND tc.session_id = atc.session_id
          AND tc.created_at <= atc.created_at
          AND tc.created_at >= COALESCE((
            SELECT MAX(prev.created_at) FROM search_metrics prev
            WHERE prev.event_type = 'agent_turn_complete'
              AND prev.agent_id = atc.agent_id
              AND prev.session_id = atc.session_id
              AND prev.created_at < atc.created_at
          ), 0)
      )
  `).get({ agentId, ...w.params }).c;

  const rate = turns > 0 ? turnsWithSearch / turns : 0;
  return { turns, turnsWithSearch, rate };
}

function truncationRate(db, { agentId, sinceMs } = {}) {
  if (!agentId) throw new Error('truncationRate: agentId required');
  const w = sinceClause(sinceMs);
  const truncations = db.prepare(`
    SELECT COUNT(*) AS c FROM search_metrics
    WHERE event_type = 'budget_truncation' AND agent_id = @agentId ${w.sql}
  `).get({ agentId, ...w.params }).c;
  const toolCalls = db.prepare(`
    SELECT COUNT(*) AS c FROM search_metrics
    WHERE event_type = 'tool_call' AND agent_id = @agentId ${w.sql}
  `).get({ agentId, ...w.params }).c;
  const rate = toolCalls > 0 ? truncations / toolCalls : 0;
  return { truncations, toolCalls, rate };
}

function budgetSaturation(db, { sinceMs } = {}) {
  const w = sinceClause(sinceMs);
  const exhaustedSessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS c FROM search_metrics
    WHERE event_type = 'session_budget_exhausted' ${w.sql}
  `).get({ ...w.params }).c;
  const searchSessions = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS c FROM search_metrics
    WHERE event_type = 'tool_call' ${w.sql}
  `).get({ ...w.params }).c;
  const rate = searchSessions > 0 ? exhaustedSessions / searchSessions : 0;
  return { exhaustedSessions, searchSessions, rate };
}

// Median via window functions is fine in modern SQLite but fragile across
// packager builds. Pull the sorted list and compute in JS. The volume is
// low (weeks of deliberations).
function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function synthesisLengthDelta(db, { agentId, sinceMs } = {}) {
  if (!agentId) throw new Error('synthesisLengthDelta: agentId required');
  const w = sinceClause(sinceMs);
  const rows = db.prepare(`
    SELECT path, synthesis_chars FROM search_metrics
    WHERE event_type = 'agent_turn_complete'
      AND agent_id = @agentId
      AND synthesis_chars IS NOT NULL
      ${w.sql}
  `).all({ agentId, ...w.params });
  const tool = rows.filter(r => r.path === 'tool_use').map(r => r.synthesis_chars);
  const prose = rows.filter(r => r.path === 'prose_marker').map(r => r.synthesis_chars);
  const toolMedian = medianOf(tool);
  const proseMedian = medianOf(prose);
  let deltaPct = null;
  if (toolMedian != null && proseMedian != null && proseMedian !== 0) {
    deltaPct = (toolMedian - proseMedian) / proseMedian;
  }
  return {
    toolCount: tool.length,
    proseCount: prose.length,
    toolMedian,
    proseMedian,
    deltaPct,
  };
}

function errorRate(db, { agentId, sinceMs } = {}) {
  if (!agentId) throw new Error('errorRate: agentId required');
  const w = sinceClause(sinceMs);
  const errors = db.prepare(`
    SELECT COUNT(*) AS c FROM search_metrics
    WHERE event_type = 'handler_error' AND agent_id = @agentId ${w.sql}
  `).get({ agentId, ...w.params }).c;
  const toolCalls = db.prepare(`
    SELECT COUNT(*) AS c FROM search_metrics
    WHERE event_type = 'tool_call' AND agent_id = @agentId ${w.sql}
  `).get({ agentId, ...w.params }).c;
  const rate = toolCalls > 0 ? errors / toolCalls : 0;
  return { errors, toolCalls, rate };
}

function perTierRollup(db, { sinceMs } = {}) {
  const w = sinceClause(sinceMs);
  const rows = db.prepare(`
    SELECT agent_tier, event_type, COUNT(*) AS c
    FROM search_metrics
    WHERE 1=1 ${w.sql}
    GROUP BY agent_tier, event_type
  `).all({ ...w.params });

  const tiers = {};
  for (const tier of ['A', 'B', 'C', 'D']) {
    tiers[tier] = {
      agent_turn_complete: 0,
      tool_call: 0,
      budget_truncation: 0,
      session_budget_exhausted: 0,
      handler_error: 0,
    };
  }
  for (const r of rows) {
    if (tiers[r.agent_tier] && tiers[r.agent_tier][r.event_type] != null) {
      tiers[r.agent_tier][r.event_type] = r.c;
    }
  }
  return tiers;
}

function sampleTurns(db, { agentId, path, n = 10 } = {}) {
  if (!agentId) throw new Error('sampleTurns: agentId required');
  const limit = Math.max(1, Math.min(200, Math.floor(n)));
  const conds = [
    "event_type = 'agent_turn_complete'",
    'agent_id = @agentId',
  ];
  const params = { agentId, limit };
  if (path) {
    conds.push('path = @path');
    params.path = path;
  }
  const turns = db.prepare(`
    SELECT * FROM search_metrics
    WHERE ${conds.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT @limit
  `).all(params);

  // Attach the tool_call count associated with each turn (same session,
  // between the previous turn's timestamp and this turn's timestamp).
  return turns.map(t => {
    const toolCallCount = db.prepare(`
      SELECT COUNT(*) AS c FROM search_metrics
      WHERE event_type = 'tool_call'
        AND agent_id = @agentId
        AND session_id = @session_id
        AND created_at <= @created_at
        AND created_at >= COALESCE((
          SELECT MAX(prev.created_at) FROM search_metrics prev
          WHERE prev.event_type = 'agent_turn_complete'
            AND prev.agent_id = @agentId
            AND prev.session_id = @session_id
            AND prev.created_at < @created_at
        ), 0)
    `).get({ agentId, session_id: t.session_id, created_at: t.created_at }).c;
    return { ...t, tool_call_count: toolCallCount };
  });
}

module.exports = {
  toolUseEmissionRate,
  truncationRate,
  budgetSaturation,
  synthesisLengthDelta,
  errorRate,
  perTierRollup,
  sampleTurns,
};
