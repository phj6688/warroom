-- HLB-337 — per-session estimated cost, derived from the per-(route, model)
-- token tally and the operator's pricing/subscription/electricity config.
-- total_cost_usd is the grand total in USD; cost_breakdown is a JSON object of
-- per-route dollar amounts. Both null until a deliberation completes under the
-- cost engine.
ALTER TABLE sessions ADD COLUMN total_cost_usd REAL;
ALTER TABLE sessions ADD COLUMN cost_breakdown TEXT;
