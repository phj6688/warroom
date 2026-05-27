# War Room — Self-Improvement Roadmap v1

**Date:** 2026-05-27 · **Branch:** `feat/self-improvement-roadmap`
**Origin:** Dogfooded War Room session `2f365b66` (8 agents, 5 phases, Complete). This spec is the synthesized verdict — the deliberation transcript is NOT committed (per Session Artifact Hygiene).

## Goal
Make War Room dramatically more **user-friendly** and **attractive to software engineers AND scientists** (equal weight). Telemetry-grounded on 87 real live sessions, not estimates.

## The numbers that drive this (live DB, 2026-05-27)
- **Output quality: 0 of 87 sessions scored ≥0.8** (composite). 30 <0.4, 40 in 0.4–0.6, 17 in 0.6–0.8. Base rate of "good" is indistinguishable from zero.
- **Escalation answer-rate: 257/560 = 45.9%.** 303 abandoned. `process-architect` worst at 41/137 = **29.9%**; `research-scout` best at 90/136 = **66.2%** — a 36-point spread on identical UI ⇒ prompt-shape, not UI.
- **560/560 escalations are `blocking`** — the `optional` tier (PR #8, hours old) has zero usage yet. Severity inflation trains the human to ghost.
- 78/87 (89.7%) reach Synthesis. Avg 14.3 messages/session (max 24) ⇒ ~2,900 words of monospace per session.
- PR #8 features (Engineer/Scientist presets, optional-severity, synthesis-quality tap) have **no usage signal yet** — treat as *unvalidated*, NOT *failed*.

## The verdict (one sentence)
Ship a **typed markdown renderer first** as the rendering-and-measurement substrate every other improvement plugs into, then **instrument before iterating**, fixing the escalation loop and adding engineer/scientist trust artifacts as a **gated sequence — not a checklist**.

## Why the renderer ships first (not the loudest number)
Quality (0/87) is the loudest number but the least actionable in one PR. Escalation (46%) is its causal upstream. **Markdown-as-plaintext** is the only candidate that is (a) 100% reproducible, (b) affects every user every session, (c) shippable in one focused PR, and (d) the **substrate for every other slot** — escalation cards, repro footer, code blocks, equations, citations all render through it. Its own Δ is *readability/abandonment/tap-engagement*, not composite quality — which is exactly why it must ship first: without it we cannot *detect* whether the later quality work moved anything.

## Current render path (the thing we are replacing)
**Served file is `public/index.html`** (via `express.static`, `lib/routes.js:66`). Root `index.html` (65KB) is **stale/dead — not served**; flag for deletion as separate cleanup, out of scope here.

`formatMessageContent()` (~`public/index.html:2793`) does only: strip `<need_human_input>` markers, `**bold**`→`<strong>`, and a verdict/recommendation header highlight. `##` headings, `1.`/`2.` lists, ``` ``` ``` fences, `$…$` math, tables, links all pass through as **raw text** injected into `innerHTML`. `addMessage()` (~`:2801`) also has an existing "Show more" collapse for messages >500 chars and a `.msg-verdict` highlight — **both must be preserved** by the new renderer.

---

## SLOT #1 — SHIP FIRST: Typed markdown renderer + typography + per-agent accents · [UX] · M

**Indivisible. If any acceptance criterion below is missing, slot #1 has *not* shipped (a library drop is a non-ship).**

### Acceptance criteria (non-negotiable — Red-Team-hardened)
1. **`markdown-it({ html: false, linkify: true, breaks: false })`** — `html:false` is the XSS guard. Agent output includes web-search results (untrusted strings); raw HTML must never be honored.
2. **KaTeX restricted to `\(…\)` and `$$…$$` delimiters only** — no single-`$`, so prose like "costs $50" never becomes garbage math.
3. **highlight.js invoked only on fenced code blocks** with explicit or detected language — never an auto-scan of prose.
4. **CDN assets pinned with SRI hashes AND a vendored fallback** committed to the repo — a CDN outage must not break a single-file vanilla app. (Total ~30KB gz: markdown-it + KaTeX + hljs, both latter lazy-loaded — KaTeX only if `\(`/`$$` present, hljs only if a fence is present.)
5. **Render once per message into a `DocumentFragment` → `appendChild`. Never re-render the feed.** `contain: layout style` on each message wrapper. (Satisfies the WS-flicker rules: new node append, not feed-wide `innerHTML` replacement.)
6. **Typography pass:** heading hierarchy, list indent, blockquote left-bar, inline-code chips, mobile-scrollable tables.
7. **8-hue per-agent accent** on the left bar of each message card, within the matrix-green family (one stable hue per core agent for scan-by-author).
8. **Preserve existing behavior:** `.msg-verdict` header highlight and the >500-char "Show more" collapse must still work.

### Visual target
Before: literal `##`, raw `1. 2. 3.`, gray code prose, ASCII equation. After: typeset heading, numbered list, inline-code chips, a display equation in a boxed `$$…$$`, blockquote with amber left-bar, syntax-highlighted code block with a per-block Copy button, `file:line` dotted-underline link, citation chip. (Reference mockup produced during brainstorming; matrix-green / JetBrains-Mono, identical content rendered both ways.)

### Pass/fail at N≥30 post-ship sessions
Mid-session abandonment measurably down; synthesis-card tap-rate non-zero; no WS-flicker regression on mobile (375px).

---

## Slots 2–9 (ranked, gated sequence)

| # | Item | Tag | Effort | Why this audience cares |
|---|------|-----|--------|-------------------------|
| 2 | **Telemetry dashboard + migration 017** (`escalation_events` completion fields, `synthesis_taps` table; `/admin.html` or `?admin=1` + JSON endpoint); **first artifact = PR #8 pre/post comparison** | [QUALITY] | M | Hard gate for #3/#4 — every PR after #1 is faith-based without it. Also catches "PR #8 already fixed process-architect." |
| 3 | **Prompt-discipline iteration on PR #8**: per-agent ask-budget + "what changes in synthesis if unanswered" justification clause | [QUALITY] | S | The 36-pt gap (PA 30% vs Scout 66%) on identical UI is prompt-shape. Biggest single answer-rate lever. |
| 4 | **Escalation sticky top-of-stream card**: [A]/[B] buttons, keyboard 1/2, "answering unblocks ⟨agent⟩" hint, unanswered-pill + jump-to in phase rail | [ESCALATION] | M | UI half of 46→65%. Recaptures the 303 abandoned. Both audiences. |
| 5 | **Reproducibility footer + "why this score"** (merged `<details>` on synthesis card: model, seed, prompt-hash, agent set, 5 quality metrics, shadow-answer delta, Copy-repro button) | [SCI]/[QUALITY] | S | Highest trust-per-byte for scientists ("real instrument, not chatbot"); engineers reuse for bug reports; lands on the card 89.7% of sessions reach. |
| 6 | **Phase-progress micro-feedback** (shimmer + "agent X is thinking" + elapsed counter) | [UX] | S | Cheapest mid-session retention; parallelizable; does NOT gate #5 (carries WS-plumbing slip risk). |
| 7 | **Code-fence highlighting + per-block Copy + `file:line` auto-linkification** | [ENG] | S | Engineers bounce by message 5 if code is gray text. Minimum admission ticket. |
| 8 | **KaTeX inline + display math + citation chips** (`[@doi:…]`/`[1]`) → footnote panel | [SCI] | M | A wrong-looking equation is immediately disqualifying. Equations + citations are scientist table stakes. |
| 9 | **Synthesis-card audience toggle** (pure CSS: collapse/expand pre-existing sub-blocks by the existing preset chip) | [ENG]+[SCI] | S | Carries the Engineer/Scientist preset through to output. Zero-risk; if metrics don't move, it cost nothing. Backlog at first sign of scope creep into the synthesis prompt. |

## Gates & sequencing rules (the antidote to ritual completionism)
- **Slot #1 is indivisible** (all 8 acceptance criteria) or it has not shipped.
- **Slot #2 is a hard gate for #3 and #4** — no `/admin/stats` returning real numbers for the last 30 sessions ⇒ no prompt iteration, no escalation card.
- **#3 and #4 cannot ship in parallel** — they share the escalation-answer-rate signal and attribution would be lost. Everything else post-#1 *can* parallelize **iff its telemetry signal is disjoint** (#1 = tap-rate/abandonment, #2 = none, #5/#7/#8/#9 = audience-specific tap-rate).
- **Pre-flight SQL** (half-day, owned by whoever ships #2, runs between #2 and #3): correlate composite score with (a) unanswered-escalation count, (b) message count, (c) per-agent answer-rate across the existing 87 sessions. A null result **rewrites #3's justification** (to the prompt-shape gap alone) but does **not** change the order.
- **Per-PR evaluation window: N≥30 post-ship sessions** before declaring a slot done. If post-ship volume is <10/week, serial evaluation stretches the roadmap; the disjoint-signal parallelization rule mitigates.

## Success criteria — projections, NOT commitments (base rate is 0/87)
1. First non-zero ≥0.8 quality session within 30 post-#4 sessions.
2. Escalation answer-rate ≥60% within 60 post-#4 sessions.
3. Synthesis-card tap-rate ≥40% within 30 post-#1 sessions.

"Done" = these numbers move, **not** "9 PRs merged." If the renderer ships and tap-rate doesn't move within 30 sessions, it was deployed, not delivered.

## DO NOT BUILD (5 items, above the fold)
1. No framework rewrite, no build step, no React/Next/Svelte — frontend stays single-file vanilla.
2. No deep repo indexing, no AI-onboarding tour, no new agent personas, no new deliberation phases (funnel is leaky at *escalation/output-trust*, not at *entry* — 89.7% reach Synthesis).
3. No second composite-quality scorer / new eval rubric (N=87 can't support it; <300 multiplies noise).
4. No theme switcher / light mode (dark-only is a hard constraint; will surface as "while we're in the renderer…").
5. No per-token streaming within messages (violates the render-once message-atomicity contract + the WS flicker rule).

## Uncertainties (carried from the deliberation)
1. **Does composite quality move with escalation-answer-rate?** Unmeasured. The pre-flight SQL falsifies it cheaply before #3.
2. **Did PR #8 already lift process-architect to ~50%?** Hours-old; slot #2's first artifact will tell us.
3. **Post-ship session volume** governs how serial the roadmap is.
4. **Whether the scientist audience exists at the volume implied by equal weighting** — preset adoption from slot #2's dashboard may rebalance #7 vs #8 effort.
5. **Whether the composite scorer itself is the bottleneck** (deep form of Red Team Attack 2) — out of scope for v1; if all 9 ship and ≥0.8 stays at 0, the scorer is the next investigation, not more features.

## Dissent (recorded)
- **Systems Synthesizer** placed phase-progress at #2 ahead of the dashboard; overruled by the dependency argument (#3/#4 need the dashboard for pass/fail).
- **Red Teamer** argued slot #9 is under-specified theater; accepted in tightened pure-CSS form, backlog at first scope creep.
- **Implicit minority view:** ship the escalation card before the renderer. Rejected — the card renders *through* the markdown pipeline, so a card on a plaintext wall recreates the abandonment problem inside the card.

## First build target
**Slot #1 only**, this branch. Slots 2–9 stay on this roadmap, gated as above; each enters dev only after the prior gate clears and is re-justified against post-ship telemetry.
