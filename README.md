# ⚔️ War Room

> *Eight minds. Five phases. One answer.*

**War Room** is a multi-agent AI deliberation engine that assembles a council of 8 specialized cognitive agents to rigorously analyze complex problems — from architecture decisions to strategic pivots. Each agent has a distinct role, reasoning style, and area of expertise. Together they run a structured 5-phase deliberation and produce a synthesized, battle-tested recommendation.

---

## How It Works

A problem is submitted. Eight agents convene. They deliberate across five structured phases. A synthesis emerges.

```
Problem Statement
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 1 — Problem Framing                                  │
│  🎯 Process Architect · 🔍 Research Scout · 🔗 Synthesizer  │
│  → Define scope, gather context, map the terrain            │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 2 — Divergence                                       │
│  💡 Divergent Generator · 🔗 Synthesizer                    │
│  📐 Quantitative Expert · 📜 Qualitative Expert             │
│  → Generate solutions without judgment                      │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 3 — Convergence                                      │
│  ⚖️ Convergent Evaluator · 📐 Quantitative Expert           │
│  📜 Qualitative Expert · 🔍 Research Scout                  │
│  → Evaluate, rank, and narrow the field                     │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 4 — Red Team                                         │
│  🔴 Red Teamer · ⚖️ Convergent Evaluator · 🎯 Process Arch  │
│  → Attack every assumption. Find every failure mode.        │
└─────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│  Phase 5 — Synthesis                                        │
│  🎯 Process Architect                                       │
│  → Final recommendation with full reasoning chain          │
└─────────────────────────────────────────────────────────────┘
```

---

## The Council

| Agent | Role | Hat | Purpose |
|-------|------|-----|---------|
| 🎯 **Process Architect** | Metacognitive Conductor | Blue Hat | Orchestrates the deliberation, ensures rigor, produces final synthesis |
| 🔗 **Systems Synthesizer** | Boundary Spanner | Cross-Domain | Connects ideas across disciplines, spots emergent patterns |
| 💡 **Divergent Generator** | Creative Disruptor | Green Hat | Generates unconventional ideas without judgment |
| ⚖️ **Convergent Evaluator** | Analytical Engine | Black/White Hat | Rigorously evaluates and ranks proposals |
| 🔴 **Red Teamer** | Adversarial Stress-Tester | Devil's Advocate | Attacks every assumption, finds failure modes |
| 📐 **Quantitative Expert** | Technical Depth | STEM | Provides data, math, and empirical grounding |
| 📜 **Qualitative Expert** | Institutional Depth | Policy/Business | Brings human, organizational, and strategic context |
| 🔍 **Research Scout** | Information Architect | Intel | Gathers live intelligence via web search (Tavily) |

---

## Architecture

```
┌────────────────────────────────────────────┐
│              War Room Server               │
│          Node.js + Express + WS            │
├────────────────────────────────────────────┤
│  WebSocket  │  REST API  │  Static UI      │
├────────────────────────────────────────────┤
│           SQLite (WAL mode)                │
│  sessions · messages · escalations        │
├────────────────────────────────────────────┤
│           LLM Backend                      │
│  OpenAI-compatible  OR  Anthropic (native) │
├────────────────────────────────────────────┤
│           Search Backend (optional)        │
│           Tavily API → Research Scout      │
└────────────────────────────────────────────┘
```

**Stack:** Node.js 22 · Express · WebSocket (`ws`) · SQLite (`better-sqlite3`) · Docker

---

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/agents` | List all 8 agents with roles and metadata |
| `GET` | `/api/sessions` | List all deliberation sessions |
| `POST` | `/api/sessions` | Create new session (body: `{problem, file_ids[]}`) |
| `GET` | `/api/sessions/:id` | Get session state, messages, escalations |
| `POST` | `/api/sessions/:id/advance` | Advance to next phase |
| `POST` | `/api/sessions/:id/escalate` | Submit escalation answer |
| `GET` | `/api/sessions/:id/export` | Export full session transcript |
| `GET` | `/api/files-service-config` | Get files-service URL + token for direct upload |
| `GET` | `/health` | Service health check |

**File handling:** War Room does not process files locally. File upload, extraction, and tokenization are handled by an external **files-service** (a standalone container), configured via the `FILES_SERVICE_URL` env var. The frontend uploads directly to files-service and passes `file_ids` when creating a session. War Room fetches file metadata and content blocks from files-service at deliberation time. File upload is optional — War Room runs without it.

**WebSocket** at `ws://<host>:8090` — real-time agent message streaming during deliberation.

---

## Quick Start

### Docker (recommended)

```bash
git clone git@github.com:phj6688/warroom.git
cd warroom

# Configure
cp .env.example .env
# Edit .env — set your LLM backend

# Deploy
docker compose up -d

# Open
open http://localhost:8090
```

### Local

```bash
npm install
node server.js
```

---

## Configuration

Create `.env` from `.env.example`:

```env
# LLM Backend — pick one:

# Option A: any OpenAI-compatible API (OpenAI, OpenRouter, Groq, Gemini, ...)
OPENAI_API_KEY=sk-...
# OPENAI_BASE_URL defaults to OpenAI; set for other providers:
# OPENAI_BASE_URL=https://openrouter.ai/api/v1
MODEL=gpt-4o

# Option B: Anthropic (native API)
ANTHROPIC_API_KEY=sk-ant-...
MODEL=claude-sonnet-4-5

# Search (optional — enables Research Scout live web search)
TAVILY_API_KEY=tvly-...

PORT=8090
```

---

## MCP Server

War Room ships an MCP (Model Context Protocol) server, enabling any MCP-compatible AI client to create and run War Room sessions programmatically.

```bash
# Run MCP server
node mcp-server.mjs

# Or via npm
npm run mcp
```

---

## Project Structure

```
war-room/
├── server.js           # Main server — agents, phases, LLM orchestration
├── mcp-server.mjs      # MCP server for AI client integration
├── mcp-server.js       # MCP server (CommonJS variant)
├── db.js               # Database helpers
├── public/
│   └── index.html      # Web UI — real-time deliberation interface
├── data/               # SQLite database (gitignored)
├── uploads/            # (legacy, unused — file handling delegated to files-service)
├── docker-compose.yml
├── Dockerfile
└── tests/
    └── export.test.mjs
```

---

## Use Cases

- **Architecture decisions** — Should we use microservices or a monolith?
- **Strategic pivots** — Where should this product go next?
- **Technical tradeoffs** — Which database fits this workload?
- **Risk analysis** — What can go wrong with this plan?
- **Research synthesis** — What does the literature say about X?

Any problem worth thinking hard about is worth running through the War Room.

---

## Part of the LUMO Homelab

War Room is one node in a broader homelab AI swarm:

| Service | Purpose |
|---------|---------|
| **War Room** | Multi-agent deliberation engine |
| **Cortex** | Project and task management |
| **IRIS** | Video intelligence platform |
| **Squad Monitor** | Agent message bus and event backbone |
| **ER Bridge** | Circuit breaker and approval gate |

---

*Built with conviction. Runs on premises. Answers with evidence.*
