# War Room: Token Cost Visibility and Per-Agent Model Routing

Date: 2026-06-12
Linear: epic HLB-334; stories HLB-335 (display), HLB-336 (routing), HLB-337 (cost).
Predecessor: HLB-152 (per-session token accounting backend, merged in 03c9dc8).

## Context

HLB-152 already ships the accounting backend: a per-session token ledger
(`lib/token-usage.js`), `total_tokens` and `token_breakdown` columns on the
`sessions` table (migration `018`), Anthropic and OpenAI usage normalization, a
`tokens-counted` WebSocket event, and unit and e2e tests. `enrichSession()`
(`lib/routes.js:49-62`) returns `totalTokens` and `tokenBreakdown` on every
`/api/sessions` and `/api/sessions/:id` payload.

Two gaps remain, and they match the ask "displayed on the fly and at the end on
history":

1. The Vue SPA (`public/index.html`) never references `totalTokens`,
   `tokenBreakdown`, or `tokens-counted`. The data reaches the browser and is
   dropped, so history shows no token figure.
2. `tokens-counted` only broadcasts at three completion points
   (`server.js:793`, `837`, `872`), so a counter would jump to the final number
   rather than ticking up during deliberation.

Separately, model and provider selection is limited: `resolveModel(agentId)` in
`lib/llm.js` reads restart-time `AGENT_MODEL_<id>` env vars and falls back to one
global `MODEL`, and the provider is global (one `OPENAI_BASE_URL` + key, or
Anthropic-direct). There is no UI and no per-agent provider routing.

## Decisions

- Config scope (answered): persisted per-agent defaults that a casual user never
  touches, plus a per-session override available behind an advanced panel for
  power users. Defaults first, tweakability second.
- Subscription and local cost (answered): the cliproxy subscription route is
  priced as an amortized fraction of the flat plan price (plan price divided by
  the period token allowance). Local Ollama is priced from a rough one-time
  electricity calibration reduced to a per-token rate, then applied per token.
  Neither is treated as zero.
- No War Room session: this is a design-and-build problem, not a high-stakes
  fork between competing strategies.
- Phased delivery: PR1 display, PR2 routing, PR3 cost, each verified before the
  next.
- Never route through the operator-personal Nexus gateway. Public routes are
  OpenRouter or the cliproxy subscription gateway.

## Architecture

Everything reduces to `tokens x an effective input/output $ rate per (route,
model)`. The three route families derive that rate differently:

- API key (Anthropic, OpenAI) and OpenRouter: published per-model rates.
- Subscription (cliproxy gateway): amortized = flat plan price / period token
  allowance.
- Local Ollama: electricity = power draw x inference time x price per kWh,
  calibrated once into a per-token rate.

Routes: `anthropic-api`, `openai-api`, `openrouter`, `subscription`,
`ollama-local`.

## Phase 1: Display (HLB-335)

- History list and session detail show the per-session grand total.
- Active session shows a live counter, driven by a new throttled `token-tick`
  WS broadcast (at most one render per 1 to 2 seconds, `textContent` only, never
  `innerHTML` in the WS loop).
- Session detail shows the per-category breakdown from `tokenBreakdown`.
- `warroom_list_sessions` and `warroom_get_session` surface `totalTokens`.

## Phase 2: Per-agent model and provider routing (HLB-336)

- New `agent_config` table (agent id, route, model) via a `db.js` migration,
  seeded so behavior is unchanged out of the box.
- `resolveModel()` becomes a resolver returning a route plus model; per-agent
  route handlers in `lib/llm.js` for all five routes, each with its own base URL
  and credential. `AGENT_MODEL_<id>` still honored as an override.
- Settings panel and a collapsed advanced section at session launch in
  `public/index.html`; per-session overrides persisted on a new `model_routing`
  JSON column on `sessions`.
- Ledger records model and route on every usage entry, feeding Phase 3.

## Phase 3: Cost engine (HLB-337)

- Pricing config mapping (route, model) to input and output $/MTok, editable in
  Settings, seeded with published API and OpenRouter rates.
- Subscription cost: amortized rate, labeled amortized. Defaults from Claude Max
  and a ChatGPT-class plan.
- Ollama cost: electricity-calibrated per-token rate, labeled estimated.
- Persist `total_cost_usd` and per-route `cost_breakdown` on `sessions`; show the
  dollar figure beside tokens in history, live, and in the breakdown.

## Data model changes

- Phase 2: `agent_config` table; `model_routing` JSON column on `sessions`;
  model and route fields on ledger entries.
- Phase 3: `total_cost_usd` and `cost_breakdown` columns on `sessions`; pricing
  and calibration config store.

## UX

Defaults are good out of the box. Casual users see token totals and cost without
configuring anything. Power users open an advanced panel (Settings, and a
collapsed section at session launch) to pick each agent's model and route and to
edit pricing and calibration parameters.

## Non-goals

- Multi-tenant or per-end-user billing; config is per deployment.
- Payment collection or invoicing.
- Rewriting the existing ledger or schema; both are extended.

## Verification

- Backend unit tests for the throttle, the resolver, and the cost math.
- Playwright against a running instance: history totals match `/api/sessions`;
  a live counter increments at least twice during a run; the breakdown sums to
  the grand total; before and after screenshots saved and read.
- `docker compose up -d --build --force-recreate` on `:8090` (the dev instance
  built from this checkout), `curl` the touched routes, and a DB query proving
  persisted values, before declaring any phase done.
