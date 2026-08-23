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
// Guarded twice over: the caller only runs it when the deployment's default
// route is actually subscription-backed, and a marker in app_settings makes it
// run once rather than on every boot.

const MARKER_KEY = 'cost_reprice_v1';

/**
 * @param {object} deps
 * @param {object} deps.db          better-sqlite3 handle
 * @param {object} deps.appConfig   settings cache (get/set)
 * @param {func}   deps.costConfig  () -> { pricing, subscription, electricity, routeBilling }
 * @param {func}   deps.billingForRoute (route, routeBilling) -> mode
 * @param {func}   deps.amortizedPerToken (subscription) -> $/token
 * @param {func}   deps.electricityPerToken (electricity) -> $/token
 * @param {object} deps.log
 */
function repriceLegacySessions(deps) {
  const { db, appConfig, costConfig, billingForRoute, amortizedPerToken, electricityPerToken, log } = deps;

  if (appConfig.get(MARKER_KEY, null)) {
    return { skipped: 'already applied', repriced: 0, left: 0 };
  }

  const cfg = costConfig();
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

      const usd = (row.total_tokens || 0) * perToken;
      if (Math.abs(usd - row.total_cost_usd) < 1e-9) { left++; continue; }

      update.run(usd, JSON.stringify({ [routes[0]]: usd }), row.id);
      repriced++;
    }
    appConfig.set(MARKER_KEY, { at: Date.now(), repriced });
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

module.exports = { repriceLegacySessions, MARKER_KEY };
