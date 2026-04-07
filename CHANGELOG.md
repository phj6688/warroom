# Changelog

All notable changes to War Room are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed
- Archived sessions all rendering as "Unclassified" in the session-history view. Three independent bugs combined to produce the symptom:
  1. Tests spawned the server without setting `WAR_ROOM_DB_PATH`, so test fixtures landed in the canonical `./data/warroom.db` and pushed every previously classified session past the `LIMIT 50` window of `getRecentSessions`. `tests/_helpers.mjs` now mints a temp DB per spawn by default and cleans it up on `dispose()`.
  2. The LLM gateway gateway ignores compact system prompts and replies with prose, so `parseClassification` always saw `null`. The classifier now inlines the rubric on the user turn so both gateway-fronted and direct-Anthropic configurations return the four labelled lines.
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
- LLM gateway Gateway support — routes LLM calls through homelab proxy
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
