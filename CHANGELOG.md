# Changelog

All notable changes to War Room are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- OpenClaw Gateway support — routes LLM calls through homelab proxy
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
