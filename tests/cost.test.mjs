// HLB-337 — cost engine. Pure functions verified with controlled token tallies
// so the assertions don't depend on live provider rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCost, costFromSnapshot, rateForModel, amortizedPerToken, electricityPerToken,
  DEFAULT_SUBSCRIPTION, DEFAULT_ELECTRICITY,
} from '../lib/cost.js';
import { createTokenLedger } from '../lib/token-usage.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('published route: cost = input*inRate + output*outRate per MTok', () => {
  const r = computeCost({ 'anthropic-api::claude-opus-4-8': { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 } });
  near(r.total_cost_usd, 30); // 1*5 + 1*25
  near(r.cost_breakdown['anthropic-api'], 30);
  assert.equal(r.modes['anthropic-api'], 'published');
});

test('prefix model match: dated haiku id resolves to the haiku rate', () => {
  const r = computeCost({ 'openrouter::claude-haiku-4-5-20251001': { input_tokens: 2e6, output_tokens: 1e6, total_tokens: 3e6 } });
  near(r.total_cost_usd, 7); // 2*1 + 1*5
  assert.equal(r.modes['openrouter'], 'published');
});

test('subscription route: amortized flat-fee fraction (default $200 / 200M = $1/MTok)', () => {
  const r = computeCost({ 'subscription::claude-opus-4-8': { input_tokens: 600000, output_tokens: 400000, total_tokens: 1e6 } });
  near(r.total_cost_usd, 1); // 1e6 * (200/200e6)
  assert.equal(r.modes['subscription'], 'amortized');
});

test('ollama-local route: electricity-calibrated per-token rate', () => {
  const perTok = electricityPerToken(DEFAULT_ELECTRICITY); // (350/1000)*(1/(40*3600))*0.30
  const r = computeCost({ 'ollama-local::llama3.1:8b': { input_tokens: 500000, output_tokens: 500000, total_tokens: 1e6 } });
  near(r.total_cost_usd, 1e6 * perTok);
  assert.ok(r.total_cost_usd > 0, 'local cost is not zero');
  assert.equal(r.modes['ollama-local'], 'electricity');
});

test('mixed routes: per-route breakdown sums to the grand total', () => {
  const r = computeCost({
    'anthropic-api::claude-opus-4-8': { input_tokens: 1e6, output_tokens: 0, total_tokens: 1e6 }, // $5
    'subscription::claude-sonnet-4-6': { input_tokens: 0, output_tokens: 0, total_tokens: 1e6 }, // $1
  });
  near(r.cost_breakdown['anthropic-api'], 5);
  near(r.cost_breakdown['subscription'], 1);
  near(r.total_cost_usd, 6);
});

test('rateForModel: normalizes anthropic/ prefix and falls back to default', () => {
  near(rateForModel('anthropic/claude-opus-4-8').input, 5);
  near(rateForModel('x-ai/grok-2-unknown').input, 5); // default fallback (input 5)
});

test('custom pricing config overrides the defaults', () => {
  const r = computeCost(
    { 'anthropic-api::my-model': { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 } },
    { pricing: { 'my-model': { input: 2, output: 4 }, default: { input: 99, output: 99 } } },
  );
  near(r.total_cost_usd, 6); // 1*2 + 1*4
});

test('amortizedPerToken: zero allowance is safe (no divide-by-zero)', () => {
  near(amortizedPerToken({ planPriceUsd: 200, allowanceTokens: 0 }), 0);
  near(amortizedPerToken(DEFAULT_SUBSCRIPTION), 200 / 200_000_000);
});

test('empty tally costs nothing', () => {
  const r = computeCost({});
  near(r.total_cost_usd, 0);
  assert.deepEqual(r.cost_breakdown, {});
});

test('costFromSnapshot: fully-attributed snapshot needs no remainder', () => {
  const snap = {
    total_tokens: 2e6,
    token_breakdown: { agent_turn: { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 } },
    by_model: { 'anthropic-api::claude-opus-4-8': { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 } },
  };
  const r = costFromSnapshot(snap, 'default::claude-opus-4-8');
  near(r.total_cost_usd, 30); // 1*5 + 1*25, all on anthropic-api
  near(r.cost_breakdown['anthropic-api'], 30);
  assert.equal(r.cost_breakdown['default'], undefined);
});

test('costFromSnapshot: unattributed tokens (e.g. embeddings) fold into the default route', () => {
  const snap = {
    total_tokens: 3e6,
    token_breakdown: {
      agent_turn: { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 },
      embedding: { input_tokens: 1e6, output_tokens: 0, total_tokens: 1e6 },
    },
    by_model: { 'anthropic-api::claude-opus-4-8': { input_tokens: 1e6, output_tokens: 1e6, total_tokens: 2e6 } },
  };
  const r = costFromSnapshot(snap, 'default::claude-opus-4-8');
  near(r.cost_breakdown['anthropic-api'], 30); // attributed agent turn
  near(r.cost_breakdown['default'], 5); // remainder 1e6 input @ opus $5/MTok
  near(r.total_cost_usd, 35);
});

test('ledger: opts.model populates by_model for cost attribution', () => {
  const led = createTokenLedger();
  led.add('s', 'agent_turn', { input_tokens: 100, output_tokens: 50 }, { model: 'claude-opus-4-8', route: 'anthropic-api' });
  led.add('s', 'tool_call', { input_tokens: 10, output_tokens: 5 }, { model: 'claude-opus-4-8', route: 'anthropic-api' });
  led.add('s', 'embedding', { input_tokens: 7, output_tokens: 0 }, { estimated: true }); // no model -> not in by_model
  const snap = led.snapshot('s');
  const key = 'anthropic-api::claude-opus-4-8';
  assert.ok(snap.by_model[key], 'by_model has the route::model key');
  assert.equal(snap.by_model[key].input_tokens, 110);
  assert.equal(snap.by_model[key].output_tokens, 55);
  assert.equal(snap.by_model[key].calls, 2);
  // embedding tokens are in the grand total but not attributed to a model
  assert.equal(snap.total_tokens, 100 + 50 + 10 + 5 + 7);
  assert.equal(Object.keys(snap.by_model).length, 1);
});
