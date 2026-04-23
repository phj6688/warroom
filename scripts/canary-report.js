#!/usr/bin/env node
// S6 — canary report CLI. Read-only over the war-room SQLite DB. Prints
// the text or JSON artifact that CANARY-CRITERIA.md is evaluated against.
//
// Invocation:
//   node scripts/canary-report.js
//   node scripts/canary-report.js --since "2 weeks ago"
//   node scripts/canary-report.js --since "7 days ago" --format json
//   WAR_ROOM_DB_PATH=/tmp/x.db node scripts/canary-report.js --format json
//
// The parser accepts a handful of humane phrases ("N days ago",
// "N weeks ago", "N hours ago", ISO timestamp). Absent/invalid → null,
// which canary-views treats as "no window filter".

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const {
  toolUseEmissionRate,
  truncationRate,
  budgetSaturation,
  synthesisLengthDelta,
  errorRate,
  perTierRollup,
} = require('../lib/metrics/canary-views');

const { AGENT_SEARCH_CONFIG } = require('../lib/agents/search-config');

function parseArgs(argv) {
  const args = { since: null, format: 'text', db: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--since') args.since = argv[++i] || null;
    else if (arg.startsWith('--since=')) args.since = arg.slice('--since='.length);
    else if (arg === '--format') args.format = argv[++i] || 'text';
    else if (arg.startsWith('--format=')) args.format = arg.slice('--format='.length);
    else if (arg === '--db') args.db = argv[++i] || null;
    else if (arg.startsWith('--db=')) args.db = arg.slice('--db='.length);
  }
  return args;
}

function parseSince(s) {
  if (!s) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const rel = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(trimmed);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].toLowerCase();
    const ms = {
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    }[unit];
    return Date.now() - n * ms;
  }
  // ISO/epoch fallback
  const num = Number(trimmed);
  if (Number.isFinite(num) && num > 0) return num;
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return t;
  return null;
}

function resolveDbPath(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.WAR_ROOM_DB_PATH) return path.resolve(process.env.WAR_ROOM_DB_PATH);
  return path.join(__dirname, '..', 'data', 'warroom.db');
}

function fmtPct(x, digits = 1) {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtInt(x) {
  if (x == null || !Number.isFinite(x)) return 'n/a';
  return String(x);
}

function fmtDelta(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'n/a';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

function windowLabel(sinceMs) {
  if (sinceMs == null) return 'all history';
  const span = Date.now() - sinceMs;
  const hours = Math.max(0, Math.floor(span / (60 * 60 * 1000)));
  const days = Math.floor(hours / 24);
  const remHrs = hours - days * 24;
  return `${new Date(sinceMs).toISOString()} → ${new Date().toISOString()} (${days}d ${remHrs}h)`;
}

function searchEnabledAgentIds() {
  return Object.keys(AGENT_SEARCH_CONFIG);
}

function gather(db, sinceMs) {
  const agents = searchEnabledAgentIds();
  const emission = {};
  const truncation = {};
  const synthesis = {};
  const errors = {};
  for (const a of agents) {
    emission[a] = toolUseEmissionRate(db, { agentId: a, sinceMs });
    truncation[a] = truncationRate(db, { agentId: a, sinceMs });
    synthesis[a] = synthesisLengthDelta(db, { agentId: a, sinceMs });
    errors[a] = errorRate(db, { agentId: a, sinceMs });
  }
  const saturation = budgetSaturation(db, { sinceMs });
  const tierRollup = perTierRollup(db, { sinceMs });

  const sessionsWithSearch = db.prepare(`
    SELECT COUNT(DISTINCT session_id) AS c FROM search_metrics
    WHERE event_type = 'tool_call'
      ${sinceMs != null ? 'AND created_at >= @sinceMs' : ''}
  `).get(sinceMs != null ? { sinceMs } : {}).c;

  return {
    window: windowLabel(sinceMs),
    sinceMs,
    generatedAt: new Date().toISOString(),
    sessionsWithSearch,
    agents,
    emission,
    truncation,
    synthesis,
    errors,
    saturation,
    tierRollup,
  };
}

function renderText(report) {
  const lines = [];
  lines.push('=== War-Room Search Canary Report ===');
  lines.push(`Window: ${report.window}`);
  lines.push(`Total sessions with search: ${report.sessionsWithSearch}`);
  lines.push('');
  lines.push('Tool-use emission rate by agent:');
  for (const a of report.agents) {
    const r = report.emission[a];
    lines.push(`  ${a.padEnd(22)} ${fmtPct(r.rate).padStart(7)}  (${r.turnsWithSearch}/${r.turns})`);
  }
  lines.push('');
  lines.push('Truncation rate by agent:');
  for (const a of report.agents) {
    const r = report.truncation[a];
    lines.push(`  ${a.padEnd(22)} ${fmtPct(r.rate).padStart(7)}  (${r.truncations}/${r.toolCalls})`);
  }
  lines.push('');
  lines.push(`Budget saturation: ${fmtPct(report.saturation.rate)}  (${report.saturation.exhaustedSessions}/${report.saturation.searchSessions})`);
  lines.push('');
  lines.push('Synthesis length (median chars, tool_use vs prose_marker):');
  for (const a of report.agents) {
    const r = report.synthesis[a];
    const tool = r.toolMedian == null ? 'n/a' : String(r.toolMedian);
    const prose = r.proseMedian == null ? 'n/a' : String(r.proseMedian);
    lines.push(`  ${a.padEnd(22)} ${tool.padStart(6)}/${prose.padEnd(6)}  (Δ${fmtDelta(r.deltaPct)}, n=${r.toolCount}/${r.proseCount})`);
  }
  lines.push('');
  lines.push('Error rate by agent:');
  for (const a of report.agents) {
    const r = report.errors[a];
    lines.push(`  ${a.padEnd(22)} ${fmtPct(r.rate).padStart(7)}  (${r.errors}/${r.toolCalls})`);
  }
  lines.push('');
  lines.push('Per-tier rollup (event counts):');
  for (const tier of ['A', 'B', 'C', 'D']) {
    const t = report.tierRollup[tier];
    lines.push(`  Tier ${tier}: turns=${t.agent_turn_complete} tool_calls=${t.tool_call} truncations=${t.budget_truncation} exhausted=${t.session_budget_exhausted} errors=${t.handler_error}`);
  }
  lines.push('');
  lines.push(`Generated at: ${report.generatedAt}`);
  return lines.join('\n') + '\n';
}

function renderJson(report) {
  return JSON.stringify(report, null, 2) + '\n';
}

function printHelp() {
  process.stdout.write(`Usage: canary-report.js [options]

Options:
  --since <when>   Window start. Accepts "N days ago", "N weeks ago",
                   ISO timestamp, or unix-ms. Default: all history.
  --format <fmt>   "text" (default) or "json".
  --db <path>      Override WAR_ROOM_DB_PATH.
  -h, --help       Show this help.

Examples:
  node scripts/canary-report.js --since "2 weeks ago"
  node scripts/canary-report.js --format json --since "7 days ago"
`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const dbPath = resolveDbPath(args.db);
  if (!fs.existsSync(dbPath)) {
    process.stderr.write(`canary-report: DB not found at ${dbPath}\n`);
    process.exit(2);
  }
  const sinceMs = parseSince(args.since);

  const db = new Database(dbPath, { readonly: true });
  try {
    const hasTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='search_metrics'"
    ).get();
    if (!hasTable) {
      process.stderr.write(`canary-report: search_metrics table not found — did migrations apply?\n`);
      process.exit(2);
    }
    const report = gather(db, sinceMs);
    const out = args.format === 'json' ? renderJson(report) : renderText(report);
    process.stdout.write(out);
  } finally {
    db.close();
  }
}

if (require.main === module) main();

module.exports = { parseArgs, parseSince, gather, renderText, renderJson };
