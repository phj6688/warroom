// Sessions costed under the old rule carry metered dollars for subscription
// traffic. The backfill re-prices exactly the rows it can compute exactly, and
// leaves the rest alone rather than guessing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repriceLegacySessions, MARKER_KEY } from '../lib/cost-backfill.js';
import { billingForRoute, amortizedPerToken, electricityPerToken, DEFAULT_SUBSCRIPTION } from '../lib/cost.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const quiet = { info() {}, warn() {} };

// Minimal stand-ins: a row store with the two statements the backfill uses,
// and a settings cache. No SQLite needed, so this stays a unit test.
function fakeDb(rows) {
  return {
    rows,
    prepare(sql) {
      if (sql.startsWith('SELECT')) return { all: () => rows.map(r => ({ ...r })) };
      return {
        run: (usd, breakdown, id) => {
          const row = rows.find(r => r.id === id);
          row.total_cost_usd = usd;
          row.cost_breakdown = breakdown;
        },
      };
    },
    transaction: (fn) => fn,
  };
}

function fakeConfig(initial = {}) {
  const store = { ...initial };
  return { get: (k, d = null) => (k in store ? store[k] : d), set: (k, v) => { store[k] = v; return v; }, _store: store };
}

const deps = (db, appConfig, routeBilling = { default: 'amortized' }) => ({
  db, appConfig, log: quiet, billingForRoute, amortizedPerToken, electricityPerToken,
  costConfig: () => ({ subscription: null, electricity: null, routeBilling }),
});

test('a default-route session priced at metered rates is re-priced to the plan slice', () => {
  const rows = [
    { id: 'a', total_tokens: 572193, total_cost_usd: 3.648645, cost_breakdown: '{"default":3.648645}' },
    { id: 'b', total_tokens: 743355, total_cost_usd: 4.893535, cost_breakdown: '{"default":4.893535}' },
  ];
  const db = fakeDb(rows);
  const cfg = fakeConfig();
  const r = repriceLegacySessions(deps(db, cfg));

  assert.equal(r.repriced, 2);
  const perToken = amortizedPerToken(DEFAULT_SUBSCRIPTION); // $200 / 200M = $1/MTok
  near(rows[0].total_cost_usd, 572193 * perToken);
  near(rows[1].total_cost_usd, 743355 * perToken);
  assert.deepEqual(JSON.parse(rows[0].cost_breakdown), { default: 572193 * perToken });
  assert.ok(cfg.get(MARKER_KEY), 'the marker is written so this runs once');
});

test('a metered route is left alone: its input/output split is not recoverable', () => {
  const rows = [{ id: 'c', total_tokens: 1e6, total_cost_usd: 13, cost_breakdown: '{"openrouter":13}' }];
  const db = fakeDb(rows);
  const r = repriceLegacySessions(deps(db, fakeConfig()));
  assert.equal(r.repriced, 0);
  assert.equal(r.left, 1);
  assert.equal(rows[0].total_cost_usd, 13, 'untouched');
});

test('a multi-route session is left alone: the per-route split is not stored', () => {
  const rows = [{ id: 'd', total_tokens: 1e6, total_cost_usd: 9, cost_breakdown: '{"default":4,"openrouter":5}' }];
  const db = fakeDb(rows);
  const r = repriceLegacySessions(deps(db, fakeConfig()));
  assert.equal(r.repriced, 0);
  assert.equal(rows[0].total_cost_usd, 9);
});

test('it runs once: a second call is a no-op even with stale rows present', () => {
  const rows = [{ id: 'e', total_tokens: 1e6, total_cost_usd: 13, cost_breakdown: '{"default":13}' }];
  const db = fakeDb(rows);
  const cfg = fakeConfig();
  assert.equal(repriceLegacySessions(deps(db, cfg)).repriced, 1);
  const again = repriceLegacySessions(deps(db, cfg));
  assert.equal(again.repriced, 0);
  assert.equal(again.skipped, 'already applied');
});

test('an already-correct row is not rewritten', () => {
  const perToken = amortizedPerToken(DEFAULT_SUBSCRIPTION);
  const usd = 1e6 * perToken;
  const rows = [{ id: 'f', total_tokens: 1e6, total_cost_usd: usd, cost_breakdown: JSON.stringify({ default: usd }) }];
  const db = fakeDb(rows);
  const r = repriceLegacySessions(deps(db, fakeConfig()));
  assert.equal(r.repriced, 0);
  assert.equal(r.left, 1);
});

test('corrupt breakdown JSON is skipped, not crashed on', () => {
  const rows = [{ id: 'g', total_tokens: 1e6, total_cost_usd: 13, cost_breakdown: 'not json' }];
  const db = fakeDb(rows);
  const r = repriceLegacySessions(deps(db, fakeConfig()));
  assert.equal(r.repriced, 0);
  assert.equal(rows[0].total_cost_usd, 13);
});

test('a local route re-prices off the electricity rate', () => {
  const rows = [{ id: 'h', total_tokens: 1e6, total_cost_usd: 13, cost_breakdown: '{"ollama-local":13}' }];
  const db = fakeDb(rows);
  const r = repriceLegacySessions(deps(db, fakeConfig(), { default: 'amortized' }));
  assert.equal(r.repriced, 1);
  near(rows[0].total_cost_usd, 1e6 * electricityPerToken(null));
});
