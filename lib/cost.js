'use strict';

// HLB-337 — per-session cost estimation. Everything reduces to
// `tokens x an effective $/MTok rate per (route, model)`; the three route
// families derive that rate differently:
//   - API / OpenRouter: published per-model input/output rates.
//   - subscription (cliproxy): a flat plan price amortized over the plan's
//     token allowance per period -> an effective per-token rate.
//   - ollama-local: an electricity calibration (power x time x price/kWh)
//     reduced once to a per-token rate.
// Every figure below is an operator-editable default (stored in app_settings);
// the Settings panel lets the "nerd" path tune them, and the casual user never
// has to. Rates here are $ per million tokens.

// Published $/MTok (input, output). Claude rates are current; others and the
// fallback are reasonable defaults the operator edits to match live pricing.
const DEFAULT_PRICING = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-fable-5': { input: 10, output: 50 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  default: { input: 5, output: 25 },
};

// Subscription: a flat plan fee spread across the tokens it allows per period.
const DEFAULT_SUBSCRIPTION = { planPriceUsd: 200, allowanceTokens: 200_000_000, period: 'month' };

// Local inference: rough one-time electricity calibration.
const DEFAULT_ELECTRICITY = { powerWatts: 350, tokensPerSec: 40, pricePerKwh: 0.30 };

// Normalize a model id to a pricing-table key: drop a leading "anthropic/" and
// any "vendor/" prefix (OpenRouter style), lowercase.
function normalizeModelKey(model) {
  if (!model) return 'default';
  let m = String(model).toLowerCase().trim();
  if (m.startsWith('anthropic/')) m = m.slice('anthropic/'.length);
  if (m.includes('/')) m = m.slice(m.lastIndexOf('/') + 1);
  return m;
}

// Look up a model's published rate, with an exact match, then a prefix match
// (so "claude-haiku-4-5-20251001" resolves to "claude-haiku-4-5"), then default.
function rateForModel(model, pricing) {
  const table = pricing || DEFAULT_PRICING;
  const key = normalizeModelKey(model);
  if (table[key]) return table[key];
  for (const k of Object.keys(table)) {
    if (k !== 'default' && key.startsWith(k)) return table[k];
  }
  return table.default || DEFAULT_PRICING.default;
}

// Subscription effective $/token = flat plan price / token allowance per period.
function amortizedPerToken(sub) {
  const s = sub || DEFAULT_SUBSCRIPTION;
  if (!s.allowanceTokens || s.allowanceTokens <= 0) return 0;
  return s.planPriceUsd / s.allowanceTokens;
}

// Local electricity $/token = (powerKW x hours-per-token) x price/kWh.
function electricityPerToken(el) {
  const e = el || DEFAULT_ELECTRICITY;
  if (!e.tokensPerSec || e.tokensPerSec <= 0) return 0;
  const kwhPerToken = (e.powerWatts / 1000) * (1 / (e.tokensPerSec * 3600));
  return kwhPerToken * e.pricePerKwh;
}

// Compute cost from a per-(route, model) token tally.
//   byModel: { "<route>::<model>": { input_tokens, output_tokens, total_tokens } }
//   config:  { pricing?, subscription?, electricity? }
// Returns { total_cost_usd, cost_breakdown: {<route>: usd}, modes: {<route>: mode} }
// where mode is 'published' | 'amortized' | 'electricity'. The subscription and
// local routes price off total_tokens (a flat/derived per-token rate); API and
// OpenRouter routes price input and output separately.
function computeCost(byModel, config = {}) {
  const pricing = config.pricing || DEFAULT_PRICING;
  const amort = amortizedPerToken(config.subscription);
  const elec = electricityPerToken(config.electricity);
  const breakdown = {};
  const modes = {};
  let total = 0;
  for (const [key, t] of Object.entries(byModel || {})) {
    const sep = key.indexOf('::');
    const route = sep >= 0 ? key.slice(0, sep) : 'default';
    const model = sep >= 0 ? key.slice(sep + 2) : key;
    const input = t.input_tokens || 0;
    const output = t.output_tokens || 0;
    const totalTok = t.total_tokens != null ? t.total_tokens : input + output;
    let usd;
    let mode;
    if (route === 'subscription') {
      usd = totalTok * amort;
      mode = 'amortized';
    } else if (route === 'ollama-local') {
      usd = totalTok * elec;
      mode = 'electricity';
    } else {
      const r = rateForModel(model, pricing);
      usd = (input / 1e6) * r.input + (output / 1e6) * r.output;
      mode = 'published';
    }
    breakdown[route] = (breakdown[route] || 0) + usd;
    modes[route] = mode;
    total += usd;
  }
  return { total_cost_usd: total, cost_breakdown: breakdown, modes };
}

// Cost for a ledger snapshot ({ total_tokens, token_breakdown, by_model }).
// Tokens already attributed to a (route, model) in by_model are priced there;
// any remainder (categories logged without a model, e.g. embeddings) is folded
// into defaultRouteKey so the dollar total covers every counted token.
function costFromSnapshot(snap, defaultRouteKey, config = {}) {
  const byModel = {};
  for (const [k, v] of Object.entries((snap && snap.by_model) || {})) byModel[k] = { ...v };
  let aIn = 0, aOut = 0, aTot = 0;
  for (const v of Object.values(byModel)) { aIn += v.input_tokens || 0; aOut += v.output_tokens || 0; aTot += v.total_tokens || 0; }
  let gIn = 0, gOut = 0;
  for (const b of Object.values((snap && snap.token_breakdown) || {})) { gIn += b.input_tokens || 0; gOut += b.output_tokens || 0; }
  const remIn = Math.max(0, gIn - aIn);
  const remOut = Math.max(0, gOut - aOut);
  const remTot = Math.max(0, ((snap && snap.total_tokens) || 0) - aTot);
  if (remTot > 0 && defaultRouteKey) {
    const cur = byModel[defaultRouteKey] || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    byModel[defaultRouteKey] = {
      input_tokens: cur.input_tokens + remIn,
      output_tokens: cur.output_tokens + remOut,
      total_tokens: cur.total_tokens + remTot,
    };
  }
  return computeCost(byModel, config);
}

module.exports = {
  DEFAULT_PRICING,
  DEFAULT_SUBSCRIPTION,
  DEFAULT_ELECTRICITY,
  normalizeModelKey,
  rateForModel,
  amortizedPerToken,
  electricityPerToken,
  computeCost,
  costFromSnapshot,
};
