# Changelog

All notable changes to War Room are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- Model catalog on both surfaces: `GET /api/settings/models?route=<route>` asks the route's provider which model ids it actually serves (OpenAI-compatible `GET /models`, or the Anthropic list endpoint), sorted and deduped, with provider failures returned as `200 {ok:false, error}` like test-connection. Every model field in the Settings panel is now a combobox: a ▾ dropdown lists the full catalog for that row's selected route (cached per route), typing filters it, clicking or Enter fills the field, and free-typed ids stay valid, so the ids behind the gateway (Claude, GPT, local Ollama) are pickable instead of typed from memory. MCP clients get the same catalog via a new `warroom_list_models` tool on both transports, closing the loop with `warroom_set_model` / `warroom_test_model`. Covered by endpoint tests, an MCP-client test, and a Playwright E2E driving the dropdown per route.
- MCP clients can pick their models. `warroom_get_model_config`, `warroom_set_model` and `warroom_test_model` expose the per-agent route + model store that until now only the web Settings panel could reach, so Claude Code (or any other MCP client) can read what each agent resolves to, point one agent or all of them at a different model, probe a route+model pair before committing, and clear back to the deployment default. Writes land in the same `agent_routing` app setting the panel writes and apply immediately with no restart. Note the scope: this is a server-wide setting shared with the UI and with sessions already running, not a per-session override, and the tool descriptions say so.
- Twelve further MCP tools for capabilities that existed over HTTP/WS but had no MCP surface: `warroom_list_presets` plus `presetId` and `continuesFromSessionId` on `warroom_create_session` (role presets and session continuation), `warroom_resume_session`, `warroom_rate_session`, `warroom_get_quality`, `warroom_get_analytics`, `warroom_semantic_search`, `warroom_recall_similar`, `warroom_improve_problem`, `warroom_list_specialists`, `warroom_get_session_agents`, `warroom_get_phases`, and a `format: json` option on `warroom_export_session` returning the same shape as the HTTP export.
- Per-row connection test in the Agent Models & Providers panel: every row (master + per-agent) gets a Test button that fires a 1-token completion at that row's route+model pair via `POST /api/settings/test-connection`, proving the typed model id resolves and the provider answers before Save. Verdict in the button (green with latency, red with the provider's error in tooltip and toast); provider failures return as `200 {ok:false, error}` with the error capped at 300 chars. Also fixes the pre-existing specificity bug where `.export-modal`'s 480px max-width silently overrode `.settings-modal`'s 640px, crushing the settings grid. (#46)
- Apply-to-all master row in the Agent Models & Providers panel: pick a route + model once and fill every agent row in one click, then tweak individuals before Save. Clearing both fields resets every row to the deployment default. Covered by a static wiring test plus a Playwright E2E (`tests/e2e/apply-all.e2e.mjs`) asserting the fill, the per-agent tweak surviving Save, the API roundtrip, and the clear-all path. (#44)

### Added
- Specialists can be pointed at any provider and model, like every other agent. They are spawned per session from `agent_templates` so they never appear in the core `AGENTS` list, and the routing settings built `validIds` from `AGENTS` alone; since `sanitizeRouting` drops an unknown id with `continue` rather than an error, a specialist override returned `200` and was silently discarded, leaving all 11 templates on the deployment default forever. That is what cost the 2026-08-11 sessions `specialist-data`, `-ml`, `-infra`, `-security` and `-research-methods` while the configured provider sat idle with credit available. Three surfaces derived the routable set separately (the Settings GET/PUT, the in-process MCP transport, and the stdio transport reading it back off the endpoint), which is how they drifted, so it now lives in `lib/routable-agents.js` and all three call it. A specialist is configurable from the Settings panel, from `warroom_set_model` on either transport, and across `openai-api`, `anthropic-api`, `openrouter`, `subscription` and `ollama-local` alike; `agentId: "all"` covers them too, matching the panel's Apply-to-all. The panel marks a specialist row, since the roster is otherwise 19 undifferentiated names. `tests/specialist-routing.test.mjs` asserts listing, per-channel persistence and re-read, and that a genuinely unknown id is still dropped. (#57)

### Fixed
- Search-enabled agents ignored their configured provider and ran on the deployment default instead. `runWithTools` called `llmCall` without `agentId`, and `lib/llm.js` resolves an agent's route from exactly that id, so `research-scout`, `quantitative-expert`, `red-teamer` and every specialist resolved to `default/<MODEL>` while the Settings panel showed them on OpenRouter. `server.js` compounded it by passing `model: resolveModel(agentId)`: an explicit model outranks the agent's configured model inside `resolveRoute`, so restoring `agentId` alone would have shipped the global default model id to whichever provider the agent is routed to. Both are fixed, and the tool-loop path now resolves route and model from `agentId` exactly as the prose path does. Measured on the 2026-08-11 sessions: 57 of 110 agent turns died in a `model_cooldown` backoff storm (32s, 64s, 124s, 252s, 501s, 1012s) on one credential pool while the configured provider sat idle, and `retryDelayMs` abandons any 429 whose reset exceeds 15s, so past the second step every affected turn failed instantly with no retry. Three sessions produced zero messages. `tests/tool-loop-agent-routing.test.mjs` asserts `agentId` reaches `llmCall` on the first round and on every later round. (#56)
- Agent turns are no longer capped at 8000 output tokens, which was erasing them outright on the model every agent is routed to. Measured against `moonshotai/kimi-k3` via OpenRouter with the exact request prod sends: 8000 completion tokens, `finish_reason=length`, zero characters of content, because a reasoning model spends the budget on reasoning before its first character of text. `_callOnce` throws that as "Gateway returned empty response", which is the empty-deliberation symptom, and it is the same failure #48 fixed at 1500 reappearing at a higher number. The dead zone is a property of the model, not a fixed threshold, so raising the default only relocates the cliff: there is now no default number at all. OpenAI-compatible transports (OpenRouter, CLIProxy, Ollama) omit `max_tokens` entirely and inherit the model's own ceiling, 1M on kimi-k3 against the 8000 it was being given. The Anthropic Messages API requires the field, so uncapped there requests 64000 (`ANTHROPIC_MAX_TOKENS` to override) and retries once at whatever ceiling a lower-limit model names in its 400 rather than failing the turn. The same change removes the hardcoded caps on the remaining agent-facing paths: 8000 on final synthesis, 1500 on the follow-up responder (inside the reasoning dead zone this codebase already documents), and 1000 on the problem improver. `AGENT_MAX_TOKENS` still opts a deployment back into a cap, but anything that is not a clean positive integer now means uncapped instead of resolving to a number, because a wrong budget fails silently while no budget cannot. `tests/agent-token-budget.test.mjs` asserts the request body the provider actually receives across all three call paths, not the source text. Note the tradeoff: turns take longer now, because the model is finally allowed to finish. (#52)
- `warroom_get_decision_record` and `warroom_attach_files` answered "ops.getDecisionRecord is not a function" on the stdio transport: both transports register the same tool list from `mcp/tools.js`, but `mcp/stdio.mjs` never implemented those two ops and nothing caught it at registration. Both are implemented over REST now, and an absent op returns "not supported by this War Room MCP transport" instead of leaking a TypeError. `tests/mcp-stdio-parity.test.mjs` drives the real stdio binary against a real server so the two adapters cannot drift apart unnoticed.
- The stdio transport sent no `Authorization` header, so it only ever worked against a deployment with `WAR_ROOM_TOKEN` unset. It now forwards `WAR_ROOM_TOKEN` on every REST call.
- Sessions still classified as nothing at all after #40: the guard was right, the classifier was feeding it garbage. CLIProxy-style gateways fronting Claude Max replace the caller's system prompt with their own, so `prompts/meta/fingerprint-classifier.md` (and with it the 10-id closed list) never reached the model, which then filled `ARCHETYPE:` with its verdict on the brief it was handed ("NO-GO", "Option B (central secrets manager)"). Boot backfill scored `scanned 52, classified 0`. `buildClassifierUserTurn()` now carries the closed list, the four output labels, and an explicit "this is a category, not your answer" on the user turn, generated from `VALID_ARCHETYPES` so offered and accepted ids cannot drift. The classifier's token budget also moves off a hardcoded 200 onto the measured `REASONING_FLOOR`: the four lines are ~60 tokens either way, but a reasoning-model `QUALITY_MODEL` would spend the whole budget on reasoning, return empty, and be swallowed straight back into this same silent "0 classified" symptom. Verified on the live gateway: 6/6 real sessions classified where the same model on the same route had managed 0/52. (#50)
- Auto-spawned specialists never appeared on gateway-routed sessions, from the same dropped system prompt: the classifier could not see the domain vocabulary, so it returned names like `infrastructure-ops, not needed; this is a pure decision call`, and `spawnSpecialists()` skipped every one of them for a silent fallback to the core 8. The vocabulary now travels on the user turn, lifted out of `prompts/meta/fingerprint-classifier.md` so that file stays the only place it is edited. (#50)
- Every session in Session History rendered as "— Unclassified" / ❓ regardless of whether `fingerprint-classifier` nominally succeeded: `parseClassification()` stored whatever free text followed `ARCHETYPE:` verbatim, with no check against the 10-id closed list `ARCHETYPE_CONFIG` (public/index.html) actually knows. `lib/fingerprint.js` now discards (`archetype: null`, warn-logged) any parsed id outside `VALID_ARCHETYPES` instead of persisting it. (#40)
- `npm audit --audit-level=high` failing on `fast-uri`'s host-confusion advisory (GHSA-v2hh-gcrm-f6hx), blocking the CI `test` gate for every PR regardless of diff content. `npm audit fix`, lockfile-only. (#41)

### Changed
- Prod pinned to `QUALITY_MODEL=anthropic/claude-haiku-4-5` so all 4 `HAIKU_AGENTS` (including `fingerprint-classifier`) actually run on a haiku-class model instead of silently falling through to the opus-4-8 default. `AGENT_MODEL_<agentId>` per-agent overrides do not currently work in this deployment for any hyphenated agent id (i.e. all of them) — `infisical run` (docker/entrypoint.sh) drops hyphenated env var names from the child process env before `node server.js` ever sees them, confirmed via `/proc/<pid>/environ` on the live process. `.env.example` documents the limitation. (#42)

## [3.2.0] - 2026-07-21

### Added
- Files-service integration: War Room no longer processes files locally. Upload, extraction, tokenization, and RAG are handled by a standalone files-service container at `:9100`. Frontend uploads directly to files-service via CORS and passes `file_ids` when creating sessions.
- `lib/clients/files-service.js` — HTTP client for files-service health check, file metadata, and content retrieval.
- `lib/prompt/content-blocks.js` — builds Anthropic-format content blocks from files-service metadata for multi-modal agent context.
- `lib/migrate-files.js` — one-time legacy migration: converts inline `session_files` rows to files-service references.
- Per-file upload status in the drop zone UI: name, size, token count, status icon, extraction errors.
- Clipboard paste handler for file attachment.
- `GET /api/files-service-config` endpoint exposes files-service URL + bearer token for browser-side direct upload.
- `tests/e2e-integration.test.js` — real-services E2E test (runs with `E2E_REAL=1`).
- Baseline token usage logging via `BASELINE_LOG` env var.

### Removed
- `POST /api/upload` endpoint (file upload is now direct to files-service).
- `multer` dependency and all local file handling code.
- `ATTACHED FILES:` string injection in agent context — replaced by content blocks.
- `files: []` HTTP fallback in session creation — the original bug that silently dropped attachments.

### Changed
- Escalations now travel over a structured `escalate_to_human` tool call instead of a `<need_human_input>` XML tag in the response body. Agents invoke the tool 0-N times per turn; the tool's `question` argument is the single item the human must answer. Tool definition lives in `server.js` (`ESCALATE_TOOL`); tool-aware LLM path is `lib/llm.js` → `callAnthropicWithTools`. The XML-tag regex extractor stays as a belt-and-suspenders fallback so a prompt slip still surfaces. System-prompt footer (`lib/context.js`) now teaches rhetorical-vs-actionable with a concrete example, and all 8 per-agent prompts reference the tool by name.
- Default model bumped to `anthropic/claude-opus-4-8` (was `anthropic/claude-sonnet-4-5`). Every agent resolves to opus-4-8: with `QUALITY_MODEL` unset and no `AGENT_MODEL_*` overrides, the haiku-class agents (quality-evaluator, adversarial-twin, memory-analyzer, fingerprint-classifier) fall through to the default. `MODEL_WINDOWS` gains 200k entries for the new id.

### Fixed
- Agents routinely emitted clarifying questions as prose bullets (not the XML escalation tag), so the human never saw them. Switching escalation to a tool call makes the channel structural rather than advisory — the tool contract is what Claude parses against, not a line of markdown it can skip.
- Final Synthesis message truncated mid-table (e.g. "Autonomy Decision Matrix" cut off after the recommendations list). Root cause: `runAgentTurn` passed no `maxTokens` to `callAnthropic`, falling through to the 1500-token default — well under what the comprehensive Synthesis brief requires. The final-phase process-architect turn now uses 8000 tokens (override via `SYNTHESIS_MAX_TOKENS`).
- Cascade delete trigger (`trg_sessions_before_delete_cascade`) broken by SQLite auto-renaming references during `ALTER TABLE session_files RENAME`. Migration 014 recreates the trigger with correct table names.

### Added
- Copy-to-clipboard button in the export modal next to Download. Hits the same `/api/sessions/:id/export` endpoint, pretty-prints JSON before copying, and falls back to a hidden textarea + `execCommand('copy')` on contexts where the async Clipboard API is blocked (http:// origin outside localhost).
- Resume button in the deliberation top bar. Visible whenever an inactive session has no Synthesis message (i.e. the deliberation never reached the final phase). One click sends `resume-session` over WS with HTTP fallback when the socket is closed; `session-resumed` flips the status badge back to Active and restarts the duration timer.
- `lib/phases.js` exports `computeResumePhase(session, phases)` — walks the phase list and returns the first phase whose required agents have not all produced a message. Both resume paths (`POST /api/sessions/:id/resume` and the WS `resume-session` case) now route through it, so a session stopped during Divergence with all 6 agents already done resumes from Convergence rather than re-running Divergence from scratch. Both paths reject (409 / WS error) when every phase is already covered.
- `maestro/flows/06-resume-button.yaml` smoke test that the resume button is wired into the static HTML and hidden on the welcome view. Maestro harness (`maestro/run.sh`, `maestro/config.yaml`, flows 01-05) is now tracked in git so the mandated `./maestro/run.sh` baseline runs from a fresh checkout.

### Fixed
- Live escalation-answered update no longer requires a page reload. `addEscalationToQueue` now tags both the desktop sidebar and mobile sheet rows with an `esc-queue-<id>` class, and `markEscalationAnswered` flips them to the answered (green-bordered) state in lockstep with the inline feed card. The `pendingEscalations` counter also decrements on each answer (clamped at 0) so the red badge dot clears at zero instead of waiting for the user to open the escalations sheet.
- Archived sessions all rendering as "Unclassified" in the session-history view. Three independent bugs combined to produce the symptom:
  1. Tests spawned the server without setting `WAR_ROOM_DB_PATH`, so test fixtures landed in the canonical `./data/warroom.db` and pushed every previously classified session past the `LIMIT 50` window of `getRecentSessions`. `tests/_helpers.mjs` now mints a temp DB per spawn by default and cleans it up on `dispose()`.
  2. Some OpenAI-compatible gateways ignore compact system prompts and replies with prose, so `parseClassification` always saw `null`. The classifier now inlines the rubric on the user turn so both gateway-fronted and direct-Anthropic configurations return the four labelled lines.
  3. `loadSession()` and the WS `session-state` payload dropped `archetypeId`, `qualityScore`, `pinned`, and `specialistAgents`, so re-joining a session lost its categorization. Both paths now carry these fields.
- Boot-time `fingerprint.backfillArchetypes()` retro-classifies any completed session with a substantial problem statement but no archetype. Pre-fingerprint sessions and ones whose original classification call failed get a single throttled retry on next boot.
- Cleaned up 96 fixture rows from the canonical `./data/warroom.db` left behind by historical test runs that pre-dated the helper-level isolation fix.

### Security
- Per-client WebSocket subscriptions: `broadcast(sessionId, data)` now only delivers to clients that have subscribed to that session (via `subscribe`/`unsubscribe`, or auto-subscribe on `new-session`/`join-session`/`resume-session`). Cross-session leakage between concurrent clients eliminated.
- Added `broadcastGlobal(data)` for the rare cases that should reach every client (currently only the agent-list refresh).
- Every WebSocket message is now validated through a zod schema before reaching handler logic. Invalid messages reply with `{type:'error', code:'INVALID_MSG', detail}`. Hard caps: problem ≤ 50 KB, human-message content ≤ 10 KB, ≤ 10 files per session.
- Every state-mutating HTTP route (`POST /api/sessions`, `POST /api/sessions/:id/resume`, `POST /api/improve`, `PUT /api/sessions/:id/pin`) is gated by zod via the new `validateBody(schema)` middleware. Invalid bodies → `400 {error:'validation_failed', issues}`.
- Escalation question/answer text and human-message bodies are now HTML-escaped before insertion via `innerHTML`. Previously a user could XSS their own browser session by submitting an answer containing markup.

### Added
- `lib/validation.js` — central zod schemas plus the `validateWS` dispatcher.
- `fingerprint.backfillArchetypes()` — boot-time retro-classifier for sessions missing an archetype, throttled to one LLM call per `delayMs` to avoid hammering the gateway.

### Changed
- Replaced the `client.readyState === 1` magic number with `WebSocket.OPEN` everywhere in `server.js` and `lib/`.

---

## [3.1.0] — 2026-02-26

### Added
- Session export system — full transcripts in three modes (full / summary / insights-only) and three formats (JSON / Markdown / plain text)
- Export modal UI with mode and format selection
- `GET /api/sessions/:id/export` endpoint
- `GET /api/sessions/:id/export/options` endpoint listing available export configurations
- MCP server (`mcp-server.mjs`) — Model Context Protocol integration for programmatic session creation and execution by AI clients
- `.env.example` — documented environment configuration template
- `CHANGELOG.md`, `CONTRIBUTING.md`, `LICENSE` — project governance and documentation

### Fixed
- Init message collapsible display and positioning in the UI

---

## [3.0.0] — 2026-02-10

### Added
- 8-agent council: Process Architect, Systems Synthesizer, Divergent Generator, Convergent Evaluator, Red Teamer, Quantitative Expert, Qualitative Expert, Research Scout
- 5-phase deliberation engine: Problem Framing → Divergence → Convergence → Red Team → Synthesis
- Real-time WebSocket streaming — agent messages delivered live during deliberation
- Research Scout with Tavily API integration for live web search
- Escalation system — agents can surface blockers requiring human input mid-session
- SQLite persistence (WAL mode) — full session history, messages, escalations
- File upload — attach context documents to a session (PDF, MD, TXT, JSON)
- REST API — full CRUD for sessions, messages, escalations
- Docker deployment — single `docker compose up -d`
- OpenAI-compatible gateway support: route LLM calls through any compatible provider
- Direct Anthropic API support as fallback

---

## [2.0.0] — 2026-01-20

### Added
- Multi-phase deliberation structure (replaced single-pass approach)
- Agent specialization — distinct system prompts per cognitive role
- Persistent session storage replacing in-memory state

---

## [1.0.0] — 2026-01-05

### Added
- Initial War Room concept — single LLM call with multi-role prompt
- Basic web UI
- WebSocket for streaming output
