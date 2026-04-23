-- S6 — search_metrics table for canary observability of the web_search
-- rollout. Additive only: no existing tables are touched. Rows are written
-- from lib/metrics/search-metrics.js via a synchronous better-sqlite3 sink.
--
-- One `agent_turn_complete` row per scout-or-search-enabled agent turn
-- (including tier D turns with path='none'), plus N supporting rows:
--   `tool_call`             — one per web_search tool_use invocation
--   `budget_truncation`     — one per per-call query truncation
--   `session_budget_exhausted` — one per session when first hit
--   `handler_error`         — one per handler throw
--
-- path enum: 'tool_use' | 'prose_marker' | 'none'.
-- agent_tier: 'A' | 'B' | 'C' | 'D'.
--
-- Indices cover the three query shapes the canary views run:
--   group-by session      (e.g. saturation count)
--   per-agent time window (most views)
--   per-event-type window (cross-agent totals)

CREATE TABLE search_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_tier TEXT NOT NULL,
  path TEXT NOT NULL,
  event_type TEXT NOT NULL,
  rounds_used INTEGER,
  queries_emitted INTEGER,
  queries_executed INTEGER,
  truncated INTEGER,
  budget_exhausted_terminal INTEGER,
  synthesis_chars INTEGER,
  latency_ms INTEGER,
  error TEXT,
  provider TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_search_metrics_session
  ON search_metrics(session_id);

CREATE INDEX idx_search_metrics_agent_created
  ON search_metrics(agent_id, created_at);

CREATE INDEX idx_search_metrics_event_created
  ON search_metrics(event_type, created_at);
