'use strict';

// Re-price sessions that were costed under the old billing rule.
//
// `computeCost` used to hardcode the mode to the route id, with `published`
// (metered per-token rates) as the catch-all. Every call on this deployment
// goes out on route `default`, which is a gateway in front of a flat-fee
// subscription, so completed sessions carry a dollar figure for money that was
// never spent: 572k, 743k and 806k tokens were stored as $3.65, $4.89 and $4.11.
//
// Only rows this can re-price EXACTLY are touched. A non-published mode prices
// off total_tokens alone, and total_tokens is stored, so the recomputation is
// not an estimate. A published route needs the input/output split per model,
// which is not persisted, so those rows are left as they are rather than
// guessed at.
//
// No outer gate is needed and an env-derived one would be wrong: the per-row
// check below already skips every published route, so a genuinely metered
// deployment rewrites nothing, and honouring the operator's `route_billing`
// override here keeps this consistent with how costs are priced everywhere
// else. A marker in app_settings, keyed to the mode it ran under, makes it run
// once per billing configuration rather than on every boot.

const MARKER_KEY = 'cost_reprice_v1';

// A canonical string for "how every route is billed right now". Sorted so key
// order cannot make an unchanged configuration look new, and derived from the
// route list rather than from the rows, so it changes exactly when a mode
// changes and not when a session is added.
function billingSignature(routes, routeBilling, billingForRoute) {
  const all = [...new Set([...(routes || []), 'default'])].sort();
  return all.map(r => `${r}=${billingForRoute(r, routeBilling)}`).join(',');
}

/**
 * @param {object} deps
 * @param {object} deps.db          better-sqlite3 handle
 * @param {object} deps.appConfig   settings cache (get/set)
 * @param {func}   deps.costConfig  () -> { pricing, subscription, electricity, routeBilling }
 * @param {func}   deps.billingForRoute (route, routeBilling) -> mode
 * @param {func}   deps.amortizedPerToken (subscription) -> $/token
 * @param {func}   deps.electricityPerToken (electricity) -> $/token
 * @param {string[]} deps.routes    every configurable route id, for the marker signature
 * @param {object} deps.log
 */
function repriceLegacySessions(deps) {
  const { db, appConfig, costConfig, billingForRoute, amortizedPerToken, electricityPerToken, routes, log } = deps;

  const cfg = costConfig();
  // Eligibility is decided per row by the mode of THAT row's route, so the
  // marker has to track every route's mode, not just the default's. Keying it
  // on the default alone meant an operator who moved, say, `openrouter` to
  // amortized while the default stayed published would short-circuit here and
  // never get those rows re-priced.
  const signature = billingSignature(routes, cfg.routeBilling, billingForRoute);
  const marker = appConfig.get(MARKER_KEY, null);
  if (marker && marker.signature === signature) {
    return { skipped: 'already applied', repriced: 0, left: 0 };
  }
  const perTokenFor = {
    amortized: amortizedPerToken(cfg.subscription),
    electricity: electricityPerToken(cfg.electricity),
  };

  let rows;
  try {
    rows = db.prepare(
      'SELECT id, total_tokens, total_cost_usd, cost_breakdown FROM sessions WHERE total_cost_usd IS NOT NULL AND total_cost_usd > 0'
    ).all();
  } catch (err) {
    log.warn({ err: err.message }, 'cost reprice: sessions unreadable, skipped');
    return { skipped: 'unreadable', repriced: 0, left: 0 };
  }

  const update = db.prepare('UPDATE sessions SET total_cost_usd = ?, cost_breakdown = ? WHERE id = ?');
  let repriced = 0;
  let left = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      let breakdown;
      try { breakdown = JSON.parse(row.cost_breakdown || '{}'); } catch { breakdown = null; }
      const routes = breakdown && typeof breakdown === 'object' ? Object.keys(breakdown) : [];
      if (routes.length !== 1) { left++; continue; }

      const mode = billingForRoute(routes[0], cfg.routeBilling);
      const perToken = perTokenFor[mode];
      if (perToken == null) { left++; continue; } // published: not exactly recomputable

      // total_tokens is nullable. `|| 0` would turn an unknown token count
      // into a confident $0.00 and destroy the only figure the row still had.
      if (!Number.isFinite(row.total_tokens) || row.total_tokens < 0) { left++; continue; }

      const usd = row.total_tokens * perToken;
      if (Math.abs(usd - row.total_cost_usd) < 1e-9) { left++; continue; }

      update.run(usd, JSON.stringify({ [routes[0]]: usd }), row.id);
      repriced++;
    }
    appConfig.set(MARKER_KEY, { signature, at: Date.now(), repriced });
  });

  try {
    run();
  } catch (err) {
    log.warn({ err: err.message }, 'cost reprice failed; session costs left untouched');
    return { skipped: 'error', repriced: 0, left: rows.length };
  }

  if (repriced > 0) {
    log.info({ repriced, left }, 'cost reprice: subscription sessions no longer carry metered prices');
  }
  return { repriced, left };
}

module.exports = { repriceLegacySessions, billingSignature, MARKER_KEY };
