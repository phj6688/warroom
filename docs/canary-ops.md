# Canary Ops — web_search rollout observability

This document covers the Session 6 canary system: how to generate the
report, how to interpret it, and what to escalate.

## Daily operation

### Generate the report

```bash
# Text report over all accumulated data
node scripts/canary-report.js

# Windowed
node scripts/canary-report.js --since "2 weeks ago"
node scripts/canary-report.js --since "7 days ago"
node scripts/canary-report.js --since "48 hours ago"

# JSON for archival or diffing
node scripts/canary-report.js --format json --since "2 weeks ago" \
  > forge/session-6-canary/reports/$(date +%F).json

# Explicit DB path
WAR_ROOM_DB_PATH=/path/to/warroom.db node scripts/canary-report.js
```

Exit code 0 on success, 2 if the DB is missing or doesn't yet have the
`search_metrics` table (i.e. migrations have not applied).

### Weekly cadence

Every Monday (or after any interesting-feeling deliberation):

1. Run the weekly report:
   ```bash
   node scripts/canary-report.js --since "7 days ago" \
     > forge/session-6-canary/reports/$(date +%F)-weekly.txt
   node scripts/canary-report.js --since "7 days ago" --format json \
     > forge/session-6-canary/reports/$(date +%F)-weekly.json
   ```
2. Skim for anything outside the green bands in `CANARY-CRITERIA.md`.
3. If a tier crosses yellow, spot-check sample turns (see below).
4. If a tier crosses red, escalate (see below).

At the two-week mark, run the full canary-window report and make the
Session 7 go/no-go decision against `CANARY-CRITERIA.md`.

## Interpreting the report

The text report has six sections matching the canary-criteria metrics:

| Section | What it tells you |
| --- | --- |
| Tool-use emission rate | Of N turns where the tool was available, how many actually used it. Reading: "is the prompt landing?" |
| Truncation rate | Of N tool_calls, how many emitted more queries than the per-call cap allowed. Reading: "is the cap right?" |
| Budget saturation | Of N search-sessions, how many hit SESSION_QUERY_BUDGET. Reading: "is the session budget tight enough to bite?" |
| Synthesis length | Median synthesis chars for `tool_use` vs `prose_marker` turns per agent. Only scout has both paths today. Δ = (tool − prose) / prose. |
| Error rate | Handler throws / tool_calls. Includes Tavily timeouts, provider errors, malformed output. Red band = veto. |
| Per-tier rollup | Raw event counts by tier. Useful for checking whether a tier has enough volume to trust its rates. |

### Reading an example

```
Tool-use emission rate by agent:
  research-scout          84.0%  (42/50)
  red-teamer              58.0%  (29/50)
  quantitative-expert     44.0%  (22/50)
```

Against the `CANARY-CRITERIA.md` Tier A green (≥ 70%) and Tier B green
(≥ 50%): scout is green, red-teamer is green, quant is in the yellow
band (30–50%). That's a "read sample quant turns, figure out whether the
prompt fragment is landing" signal — not a veto.

## Spot-checking specific turns

Use `sampleTurns` via a one-liner when a metric looks off:

```bash
node -e "
const Database = require('better-sqlite3');
const { sampleTurns } = require('./lib/metrics/canary-views');
const db = new Database(process.env.WAR_ROOM_DB_PATH || './data/warroom.db', { readonly: true });
console.log(JSON.stringify(
  sampleTurns(db, { agentId: 'quantitative-expert', n: 5 }),
  null, 2
));
db.close();
"
```

The sample includes `session_id`, `created_at`, and `tool_call_count` per
turn, so you can cross-reference against the session transcript in the UI
and confirm whether the agent cited what it searched for (or ignored the
tool block entirely).

For per-path spot-checks:

```bash
# Recent tool_use scout turns
node -e "
const Database = require('better-sqlite3');
const { sampleTurns } = require('./lib/metrics/canary-views');
const db = new Database(process.env.WAR_ROOM_DB_PATH || './data/warroom.db', { readonly: true });
console.log(JSON.stringify(
  sampleTurns(db, { agentId: 'research-scout', path: 'tool_use', n: 5 }),
  null, 2
));
"
```

## What to escalate

| Signal | Who/where | Notes |
| --- | --- | --- |
| Any tier's `error_rate` > 5% over the past 7 days | Self — investigate before anything else. | Red band. Check Tavily status and LLM gateway logs before blaming the code. |
| `budget_saturation` > 35% over 7 days | Self — raise `SESSION_QUERY_BUDGET` in `.env`, note the date. | Saturation at the default-30 cap means long deliberations are losing search capacity. |
| `tool_use_emission_rate` red on any tier | Self — read 5 sample turns, adjust the fragment prompt or the tier classification in `search-config.js`. | Do NOT flip defaults in Session 7 if this tier is in red. |
| `synthesis_length_delta` > ±30% on scout | Self — read 5 samples of each path, write a note in `forge/session-6-canary/reports/` explaining which direction is better. | Signal for a human eyeball, not a veto. |
| `search_metrics` table stops getting rows during active deliberations | Self — check `lib/metrics/search-metrics.js` load, `createMetricsSink(db)` call at server startup, and that `runAgentTurn` reaches the `finally` block. | Likely an unhandled throw in a new code path. |
| Report CLI crashes with a fresh DB | Self — verify migration 015 applied: `SELECT MAX(version) FROM schema_version` should return 15 or higher. | |

Outside the personal operator loop, there is nothing to escalate to —
this is a solo project. The "escalate to whom" is a future-tense answer.

## Archival

Keep every weekly report. The diff between reports is the primary signal
for "is the canary drifting week over week":

```bash
mkdir -p forge/session-6-canary/reports
node scripts/canary-report.js --since "7 days ago" \
  > forge/session-6-canary/reports/$(date +%F)-weekly.txt
```

Commit the archived reports with the working tree — they are the audit
trail the Session 7 go/no-go is made against.

## Schema + view reference

Table: `search_metrics` (migration 015).

Views (all in `lib/metrics/canary-views.js`):

- `toolUseEmissionRate(db, { agentId, sinceMs })`
- `truncationRate(db, { agentId, sinceMs })`
- `budgetSaturation(db, { sinceMs })`
- `synthesisLengthDelta(db, { agentId, sinceMs })`
- `errorRate(db, { agentId, sinceMs })`
- `perTierRollup(db, { sinceMs })`
- `sampleTurns(db, { agentId, path, n })`

The CLI is a thin wrapper over these — nothing stops you from calling
them in a REPL for ad-hoc exploration.
