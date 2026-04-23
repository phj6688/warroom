/**
 * Unit tests for lib/metrics/canary-views.js over a seeded DB. Uses the
 * runNodeScript subprocess pattern; each test spins its own DB file,
 * applies migration 015 directly, seeds known rows, and asserts.
 *
 * Gates:
 *   - View math matches hand-calculated expected values.
 *   - `sinceMs` excludes rows older than the window.
 *   - Empty DB returns zeros, not nulls, and never throws.
 *   - CLI report (scripts/canary-report.js) runs end-to-end against a
 *     seeded DB in both --format json and --format text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const MIG_PATH = path.join(REPO_ROOT, 'migrations', '015_search_metrics.sql');
const SINK = path.join(REPO_ROOT, 'lib', 'metrics', 'search-metrics.js');
const VIEWS = path.join(REPO_ROOT, 'lib', 'metrics', 'canary-views.js');
const CLI = path.join(REPO_ROOT, 'scripts', 'canary-report.js');

function tempDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'warroom-canary-'));
  return { dir, dbPath: path.join(dir, 'warroom.db') };
}
function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }

// Seeding DSL. Each row is a sparse object; the helper fills
// agent_tier + created_at defaults. This keeps test intent readable.
function seedBlock(dbPath, rows) {
  return `
    (function seed() {
      const Database = require('better-sqlite3');
      const fs = require('fs');
      const sink = require(${JSON.stringify(SINK)});
      const db = new Database(${JSON.stringify(dbPath)});
      db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
      const s = sink.createMetricsSink(db);
      const rows = ${JSON.stringify(rows)};
      for (const r of rows) s.record(r);
      db.close();
    })();
  `;
}

async function runWithSeed(seedRows, queryBody) {
  const { dir, dbPath } = tempDb();
  try {
    const script = `
      'use strict';
      ${seedBlock(dbPath, seedRows)}
      const Database2 = require('better-sqlite3');
      const views = require(${JSON.stringify(VIEWS)});
      const db = new Database2(${JSON.stringify(dbPath)});
      try {
        ${queryBody}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      } finally {
        db.close();
      }
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    return { code, stdout, stderr, parsed };
  } finally {
    cleanup(dir);
  }
}

describe('canary-views: empty DB returns zeros', () => {
  test('every view returns sensible shapes against an empty table', async () => {
    const { parsed, stdout, stderr } = await runWithSeed([], `
      const emission = views.toolUseEmissionRate(db, { agentId: 'research-scout' });
      const trunc = views.truncationRate(db, { agentId: 'red-teamer' });
      const sat = views.budgetSaturation(db, {});
      const synth = views.synthesisLengthDelta(db, { agentId: 'research-scout' });
      const err = views.errorRate(db, { agentId: 'research-scout' });
      const tier = views.perTierRollup(db, {});
      const sample = views.sampleTurns(db, { agentId: 'research-scout', n: 5 });
      process.stdout.write(JSON.stringify({ ok: true, emission, trunc, sat, synth, err, tier, sample }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.emission, { turns: 0, turnsWithSearch: 0, rate: 0 });
    assert.deepEqual(parsed.trunc, { truncations: 0, toolCalls: 0, rate: 0 });
    assert.deepEqual(parsed.sat, { exhaustedSessions: 0, searchSessions: 0, rate: 0 });
    assert.equal(parsed.synth.toolMedian, null);
    assert.equal(parsed.synth.proseMedian, null);
    assert.equal(parsed.synth.deltaPct, null);
    assert.deepEqual(parsed.err, { errors: 0, toolCalls: 0, rate: 0 });
    assert.equal(parsed.tier.A.agent_turn_complete, 0);
    assert.equal(parsed.tier.D.tool_call, 0);
    assert.deepEqual(parsed.sample, []);
  });
});

describe('canary-views: toolUseEmissionRate math', () => {
  test('5 scout turns, 3 searched → 60% rate', async () => {
    // Seed 5 turns. Turns 1, 3, 5 get a prior tool_call (search happened).
    const t = 1700000000000;
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      const sessionId = `S${i}`;
      if (i === 1 || i === 3 || i === 5) {
        rows.push({ sessionId, agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', queriesEmitted: 2, queriesExecuted: 2, createdAt: t + i * 1000 });
      }
      rows.push({ sessionId, agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 500, createdAt: t + i * 1000 + 500 });
    }
    const { parsed, stdout, stderr } = await runWithSeed(rows, `
      const r = views.toolUseEmissionRate(db, { agentId: 'research-scout' });
      process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.turns, 5);
    assert.equal(parsed.r.turnsWithSearch, 3);
    assert.equal(parsed.r.rate, 0.6);
  });
});

describe('canary-views: truncationRate', () => {
  test('4 tool_calls with 1 truncation → 25% rate', async () => {
    const t = 1700000000000;
    const rows = [];
    for (let i = 0; i < 4; i++) {
      rows.push({ sessionId: 'S', agentId: 'quantitative-expert', eventType: 'tool_call', path: 'tool_use', createdAt: t + i });
    }
    rows.push({ sessionId: 'S', agentId: 'quantitative-expert', eventType: 'budget_truncation', path: 'tool_use', createdAt: t + 99 });
    const { parsed } = await runWithSeed(rows, `
      const r = views.truncationRate(db, { agentId: 'quantitative-expert' });
      process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.equal(parsed.r.toolCalls, 4);
    assert.equal(parsed.r.truncations, 1);
    assert.equal(parsed.r.rate, 0.25);
  });
});

describe('canary-views: budgetSaturation', () => {
  test('3 search sessions, 1 exhausted → 33.3% saturation', async () => {
    const t = 1700000000000;
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      rows.push({ sessionId: `SAT${i}`, agentId: 'red-teamer', eventType: 'tool_call', path: 'tool_use', createdAt: t + i });
    }
    rows.push({ sessionId: 'SAT1', agentId: 'red-teamer', eventType: 'session_budget_exhausted', path: 'tool_use', createdAt: t + 99 });
    const { parsed } = await runWithSeed(rows, `
      const r = views.budgetSaturation(db, {});
      process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.equal(parsed.r.searchSessions, 3);
    assert.equal(parsed.r.exhaustedSessions, 1);
    assert.ok(Math.abs(parsed.r.rate - 1 / 3) < 1e-9);
  });
});

describe('canary-views: synthesisLengthDelta', () => {
  test('3 tool_use (400, 500, 600) vs 3 prose_marker (300, 400, 500) → tool median 500, prose 400, delta +25%', async () => {
    const t = 1700000000000;
    const rows = [
      { sessionId: 'S1', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 400, createdAt: t + 1 },
      { sessionId: 'S2', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 500, createdAt: t + 2 },
      { sessionId: 'S3', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 600, createdAt: t + 3 },
      { sessionId: 'S4', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'prose_marker', synthesisChars: 300, createdAt: t + 4 },
      { sessionId: 'S5', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'prose_marker', synthesisChars: 400, createdAt: t + 5 },
      { sessionId: 'S6', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'prose_marker', synthesisChars: 500, createdAt: t + 6 },
    ];
    const { parsed } = await runWithSeed(rows, `
      const r = views.synthesisLengthDelta(db, { agentId: 'research-scout' });
      process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.equal(parsed.r.toolMedian, 500);
    assert.equal(parsed.r.proseMedian, 400);
    assert.equal(parsed.r.toolCount, 3);
    assert.equal(parsed.r.proseCount, 3);
    assert.ok(Math.abs(parsed.r.deltaPct - 0.25) < 1e-9);
  });
});

describe('canary-views: errorRate + perTierRollup', () => {
  test('2 tool_calls, 1 handler_error on tier C → 50%; tier rollup counts match', async () => {
    const t = 1700000000000;
    const rows = [
      { sessionId: 'S', agentId: 'specialist-legal', eventType: 'tool_call', path: 'tool_use', createdAt: t + 1 },
      { sessionId: 'S', agentId: 'specialist-legal', eventType: 'tool_call', path: 'tool_use', createdAt: t + 2 },
      { sessionId: 'S', agentId: 'specialist-legal', eventType: 'handler_error', path: 'tool_use', error: 'blip', createdAt: t + 3 },
      { sessionId: 'S', agentId: 'specialist-legal', eventType: 'agent_turn_complete', path: 'tool_use', createdAt: t + 4 },
      { sessionId: 'S', agentId: 'process-architect', eventType: 'agent_turn_complete', path: 'none', createdAt: t + 5 },
    ];
    const { parsed } = await runWithSeed(rows, `
      const err = views.errorRate(db, { agentId: 'specialist-legal' });
      const tier = views.perTierRollup(db, {});
      process.stdout.write(JSON.stringify({ ok: true, err, tier }));
    `);
    assert.equal(parsed.err.errors, 1);
    assert.equal(parsed.err.toolCalls, 2);
    assert.equal(parsed.err.rate, 0.5);
    assert.equal(parsed.tier.C.tool_call, 2);
    assert.equal(parsed.tier.C.handler_error, 1);
    assert.equal(parsed.tier.C.agent_turn_complete, 1);
    assert.equal(parsed.tier.D.agent_turn_complete, 1);
  });
});

describe('canary-views: sinceMs window', () => {
  test('rows older than sinceMs are excluded', async () => {
    const t = 1700000000000;
    const rows = [
      { sessionId: 'S', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', createdAt: t + 1 }, // old
      { sessionId: 'S', agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', createdAt: t + 2 },           // old
      { sessionId: 'S', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', createdAt: t + 1000 }, // new
      { sessionId: 'S', agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', createdAt: t + 1001 },           // new
    ];
    const { parsed } = await runWithSeed(rows, `
      const all = views.toolUseEmissionRate(db, { agentId: 'research-scout' });
      const windowed = views.toolUseEmissionRate(db, { agentId: 'research-scout', sinceMs: ${t + 500} });
      process.stdout.write(JSON.stringify({ ok: true, all, windowed }));
    `);
    assert.equal(parsed.all.turns, 2);
    assert.equal(parsed.windowed.turns, 1);
  });
});

describe('canary-report CLI: smoke against seeded DB', () => {
  test('--format json runs end-to-end and includes populated agent rollups', async () => {
    const { dir, dbPath } = tempDb();
    try {
      // Seed a minimal but non-trivial row set in a prep script.
      const seedCmd = `
        'use strict';
        const Database = require('better-sqlite3');
        const fs = require('fs');
        const sink = require(${JSON.stringify(SINK)});
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const s = sink.createMetricsSink(db);
        const t = Date.now();
        // Two scout turns, both searched.
        s.record({ sessionId: 'S1', agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', queriesEmitted: 3, queriesExecuted: 3, createdAt: t + 1, provider: 'tavily' });
        s.record({ sessionId: 'S1', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 800, createdAt: t + 2 });
        s.record({ sessionId: 'S2', agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', queriesEmitted: 2, queriesExecuted: 2, createdAt: t + 3, provider: 'tavily' });
        s.record({ sessionId: 'S2', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 700, createdAt: t + 4 });
        // One prose-marker scout turn (comparator).
        s.record({ sessionId: 'S3', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'prose_marker', synthesisChars: 750, createdAt: t + 5 });
        // One tier-D (no search).
        s.record({ sessionId: 'S1', agentId: 'process-architect', eventType: 'agent_turn_complete', path: 'none', createdAt: t + 6 });
        db.close();
      `;
      const seedOut = await runNodeScript(seedCmd, { timeoutMs: 15_000 });
      assert.equal(seedOut.code, 0, `seed failed: ${seedOut.stderr}`);

      const { spawn } = await import('node:child_process');
      const proc = spawn(process.execPath, [CLI, '--format', 'json'], {
        env: { ...process.env, WAR_ROOM_DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const exitCode = await new Promise((res) => proc.on('exit', res));
      assert.equal(exitCode, 0, `cli failed: ${stderr}\n${stdout}`);
      const report = JSON.parse(stdout);
      assert.equal(report.sessionsWithSearch, 2);
      assert.ok(report.emission['research-scout']);
      assert.equal(report.emission['research-scout'].turns, 2);
      assert.equal(report.emission['research-scout'].turnsWithSearch, 2);
      assert.equal(report.synthesis['research-scout'].toolCount, 2);
      assert.equal(report.synthesis['research-scout'].proseCount, 1);
      assert.equal(report.tierRollup.A.tool_call, 2);
      assert.equal(report.tierRollup.D.agent_turn_complete, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('--format text produces a non-empty, parseable report', async () => {
    const { dir, dbPath } = tempDb();
    try {
      const seedCmd = `
        'use strict';
        const Database = require('better-sqlite3');
        const fs = require('fs');
        const sink = require(${JSON.stringify(SINK)});
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec(fs.readFileSync(${JSON.stringify(MIG_PATH)}, 'utf-8'));
        const s = sink.createMetricsSink(db);
        s.record({ sessionId: 'S1', agentId: 'research-scout', eventType: 'tool_call', path: 'tool_use', queriesEmitted: 3, queriesExecuted: 3, provider: 'tavily' });
        s.record({ sessionId: 'S1', agentId: 'research-scout', eventType: 'agent_turn_complete', path: 'tool_use', synthesisChars: 500 });
        db.close();
      `;
      const seedOut = await runNodeScript(seedCmd, { timeoutMs: 15_000 });
      assert.equal(seedOut.code, 0, `seed failed: ${seedOut.stderr}`);
      const { spawn } = await import('node:child_process');
      const proc = spawn(process.execPath, [CLI], {
        env: { ...process.env, WAR_ROOM_DB_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d.toString(); });
      proc.stderr.on('data', d => { stderr += d.toString(); });
      const code = await new Promise((res) => proc.on('exit', res));
      assert.equal(code, 0, `cli failed: ${stderr}\n${stdout}`);
      assert.match(stdout, /War-Room Search Canary Report/);
      assert.match(stdout, /Tool-use emission rate by agent/);
      assert.match(stdout, /research-scout/);
      assert.match(stdout, /Per-tier rollup/);
    } finally {
      cleanup(dir);
    }
  });
});
