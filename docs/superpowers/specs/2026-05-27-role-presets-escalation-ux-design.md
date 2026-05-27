# War Room — Role Presets + Escalation UX + Decision Record

**Date:** 2026-05-27 · **Branch:** `feat/role-presets-escalation-ux`
**Origin:** Dogfooded War Room session `6d6a974c` (8 agents, 5 phases). This spec is the synthesized verdict — the deliberation transcript is NOT committed.

## Goal
Make War Room more user-friendly and attractive to **software engineers AND computational scientists** (equal weight), via one shared deliberation core + role presets. Telemetry-grounded on 86 real sessions.

## The one number that drives this
553 escalations raised, **248 answered (45%)**. `process-architect` alone raised 136 @ 29% answered. Only **3% of escalations state a default**. Median answer latency 147s ⇒ the unanswered 55% are *abandoned*, not delayed. The fix is prompt-side volume reduction + a forced-choice contract + batched UI — not notifications.

## Build order (all S-cost, reuse-only, no new services, no new LLM calls)

0. **PA prompt rewrite** — decision-budget: make framing decisions unilaterally and *announce* them; escalate ≤2×/session, only when ambiguity changes scope/success criteria. (`prompts/core/process-architect.md`)
1. **Unified preset config schema + loader** — `presets/*.md` (YAML front-matter) → `{label, examples[3], specialists[], output_template, escalation_tolerance, lead_agents?}`. `lead_agents`/`escalation_tolerance` marked `experimental` (delete if not behaviorally differentiating at n=20). (`lib/presets.js`)
2. **Escalation severity + forced-choice contract** — every escalation: `QUESTION — [A] / [B] / [REFRAME] — default: A`; agents self-tag `blocking|optional`. Optional + unanswered → auto-resolve to default at phase end. Reinforced in the shared escalation fragment used by all agents. (`prompts/fragments/`, `lib/escalation.js`)
3. **Right-rail PENDING escalation panel + bulk action** — escalations also surface as a panel (nav + batch over the inline cards, not a replacement for them; see Implementation note below), grouped by agent, rAF-batched render, single shared pulse keyed on mount. Bulk button: `ACCEPT N DEFAULTS · PROCEED` with 5s undo (no modal). `[REFRAME]` tap → inline input + auto-flag blocking. Severity = **intensity of the live red accent** (`#D71921` full = blocking, dimmed = optional) — NOT a new hue. (`public/index.html`)
4. **Engineer + Scientist presets + landing picker chips** — two chips between Improve and example chips; selecting swaps example chips (textContent) + shows specialist caption. Default = Generalist (neither). (`presets/engineer.md`, `presets/scientist.md`, `public/index.html`)
5. **`research-methods` specialist** — single `.md`: experimental design, statistical rigor (power, multiple comparisons, effect size, p-hacking), reproducibility. (`prompts/specialists/research-methods.md`)
6. **Decision Record + sticky "THE ANSWER" card** — templated from Synthesis output verbatim (zero LLM calls). Engineer header `DECISION·RATIONALE·NEXT ACTIONS·RISKS`; Scientist header `CLAIM·METHODS·EVIDENCE/CITATIONS·LIMITATIONS`. Sticky card mounts once on `synthesis_complete`. Actions: COPY · EXPORT .md · COPY AS PROMPT. **PA synthesis prompt edited to emit these structured fields** (else the record renders `[not stated]`). (`public/index.html`, `server.js` export, `prompts/core/process-architect.md`)
7. **Instrumentation** — 5 columns: `escalations.severity`, `escalations.answered_at`, `escalations.bulk_resolved`, `sessions.preset_id`, `sessions.synthesis_quality ∈ {USEFUL,PARTIAL,MISLEADING}`. Post-session 1-tap quality affordance on the Decision Record card. (migration)

## Red-Team mitigations (baked in)
- `[REFRAME]` third option stops forced-choice collapsing a real N-way decision into a wrong binary.
- `USEFUL/PARTIAL/MISLEADING` 1-tap catches *silent* quality regression from severity collapsing toward `optional`.
- PA gets a decision-*budget*, not just reworded questions.
- Decision Record depends on PA synthesis emitting structured fields — shipped together.

## Pre-commitments (in code comments)
- Delete `lead_agents`/`escalation_tolerance` preset fields if indistinguishable at n=20.
- Zero-LLM-call invariant on Decision Record (no model call in `synthesis_complete`).
- Sticky card mounts exactly once per session.

## Explicitly NOT building
Agreement-graph viz, inline agreement glyphs, auto-applied presets, 3rd "Operator" preset, wet-lab/social-science bundles, comparison-table artifact, per-user accounts, any new summarizer LLM call, mobile parity for the right-rail panel (stacked-below fallback only).

## Adaptation vs. synthesis
The synthesis gates the bundle behind shipping PA's prompt alone + measuring 10 real sessions. That gate can't run inside one automated session, so the **full bundle ships now with all instrumentation + 3 tripwires intact**; the 10-session gate + n=20 falsification become post-ship watches, not blockers.

## Implementation note — escalation surface (as shipped)
Dual surface, by design — not a regression from item #3's "panel" phrasing.
- **Inline card (feed):** the full answer surface — text input, submit, use-default, `[REFRAME]`, dismiss. Where a human answers one escalation. Reframe lives here, so making the panel sole would mean rebuilding the whole per-item UI inside it.
- **Right-rail PENDING panel (desktop):** compact nav rows (click → scroll to inline card) + the batched `ACCEPT N DEFAULTS · PROCEED` bulk action. Rows are nav-only, not a standalone answer surface. This is the anti-abandonment surface against the 45%-answered number.
- **Pulse:** only the single most-recent unanswered inline card pulses (keyed on mount); earlier cards stay static. Holds the spec's "single shared pulse keyed on mount" intent without per-card animation churn.

## Verification
Migrations apply cleanly; dev instance boots on alt port; Playwright before/after screenshots at 1280px + 375px; existing tests pass; no flicker (panel rAF-batched, sticky card single-mount).
