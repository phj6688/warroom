-- HLB-336 — runtime-editable settings store (key/value JSON).
-- Holds per-agent model+route routing under the key 'agent_routing', and later
-- (HLB-337) pricing / electricity / subscription parameters. Starts empty, so
-- resolveRoute() falls back to the existing env-driven defaults and behaviour is
-- unchanged until the operator edits something in the Settings panel.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
