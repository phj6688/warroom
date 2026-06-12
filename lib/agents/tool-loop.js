// Generic tool_use loop. Knows nothing about web_search or escalate_to_human
// specifically — callers pass a `toolHandlers` map and the loop drives the
// LLM ↔ handler round-trip until stop_reason !== "tool_use" or maxRounds.
//
// LLM transport is injected via `llmCall` so tests can mock it. `llmCall`
// receives canonical Anthropic-shape input and returns canonical output:
//
//   request: { model, system, messages, tools, maxTokens }
//   response: { stop_reason, content: [block...], usage? }
//
// Round-count semantics (spec-fixed):
//   - Each LLM call increments `rounds`.
//   - maxRounds=N caps handler invocations at N.
//   - On round N's tool_use, handlers DO run for side-effects AND their
//     output is recorded in `toolInvocations`, but the tool_result blocks
//     fed back to the LLM are OVERWRITTEN with a terminal "Search budget
//     exhausted…" note per tool_use_id. Then one more LLM call (the capped
//     synthesis) fires and the loop returns.
//
// Session 5 additions (per-call / per-session budgets):
//   - maxQueriesPerCall: truncates tool_use input.queries[] to the allowed
//     count before invoking the handler. Truncation does NOT consume a round
//     — it is a successful call, just smaller. Emits
//     `agent-tool-budget-truncated` (and legacy `scout-tool-budget-truncated`).
//   - sessionBudget: opaque object from lib/agents/search-config.js's
//     makeSessionBudget(). When `remaining < 1`, the handler is skipped
//     entirely and a non-error tool_result is injected. Fires
//     `session-search-budget-exhausted` exactly once per session.
//   - Both features are optional; when absent the loop behaves identically
//     to Session 4.

'use strict';

const { sumUsage } = require('../token-usage');

const TERMINAL_TOOL_RESULT =
  'Search budget exhausted for this turn. Synthesize with what you have.';
const SESSION_EXHAUSTED_TOOL_RESULT =
  'Session search budget exhausted. Synthesize with available information.';

async function runWithTools({
  llmCall,
  model,
  system,
  messages,
  tools,
  toolHandlers,
  maxRounds = 3,
  maxQueriesPerCall,
  sessionBudget,
  maxTokens,
  broadcast,
  sessionId,
  agentId,
  logger,
  metricsSink,
  agentTier,
  provider,
}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const emit = typeof broadcast === 'function' ? broadcast : () => {};
  const metrics = metricsSink && typeof metricsSink.record === 'function'
    ? metricsSink
    : { record: () => {} };
  const metricsBase = { sessionId, agentId, agentTier, provider, path: 'tool_use' };
  function recordSafe(event) {
    try { metrics.record(event); } catch (err) {
      log.error({ sessionId, agentId, err: err && err.message }, 'metrics sink threw');
    }
  }

  let working = [...messages];
  let rounds = 0;
  const toolInvocations = [];
  let budgetExhausted = false;
  // Token usage summed across every round-trip in this turn. The loop makes one
  // LLM call per round (plus the capped synthesis call), each reporting its own
  // usage; the caller adds this total to the session tally.
  let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  // HLB-337 — the resolved model/route for this turn (constant across rounds),
  // surfaced on the result so the caller can attribute cost.
  let usedModel = null;
  let usedRoute = null;

  // Safety bound. maxRounds + 1 for the capped-synthesis call plus a tiny
  // slack for unusually verbose scouts. We return once we see a terminal
  // stop_reason or exceed this.
  const LOOP_SAFETY = maxRounds + 2;

  for (let iter = 0; iter < LOOP_SAFETY; iter++) {
    rounds += 1;
    const t0 = Date.now();
    const response = await llmCall({ model, system, messages: working, tools, maxTokens });
    const latencyMs = Date.now() - t0;
    usage = sumUsage(usage, response && response.usage);
    if (response) { usedModel = response.model || usedModel; usedRoute = response.route || usedRoute; }

    const assistantBlocks = Array.isArray(response?.content) ? response.content : [];
    working.push({ role: 'assistant', content: assistantBlocks });

    const toolUses = assistantBlocks.filter(b => b && b.type === 'tool_use');
    const done = response?.stop_reason !== 'tool_use' || toolUses.length === 0;
    if (done) {
      return {
        finalMessage: response,
        workingMessages: working,
        rounds,
        toolInvocations,
        budgetExhausted,
        usage,
        model: usedModel,
        route: usedRoute,
      };
    }

    if (budgetExhausted) {
      // We already injected terminals once and the model STILL asked for
      // tools. Accept whatever text this response has, return forced.
      log.warn({ sessionId, agentId, rounds }, 'tool loop: post-terminal still emitted tool_use, forcing return');
      return {
        finalMessage: response,
        workingMessages: working,
        rounds,
        toolInvocations,
        budgetExhausted,
        usage,
        model: usedModel,
        route: usedRoute,
      };
    }

    // Always invoke handlers — even on the terminal round — so
    // `toolInvocations` stays complete for observability. The results get
    // either fed back normally OR overwritten by the terminal note below.
    const realResults = [];
    for (const block of toolUses) {
      const handler = toolHandlers[block.name];
      let content = '';
      let is_error = false;
      let effectiveInput = block.input || {};
      let skippedByBudget = false;

      // Capture the caller's original query count BEFORE truncation for
      // metrics emission. Prose-marker comparison needs both numbers.
      const originalQueries = Array.isArray(effectiveInput.queries)
        ? effectiveInput.queries.length
        : null;
      let truncatedThisCall = false;
      let handlerLatencyMs = null;
      let handlerError = null;

      // Session-wide budget gate. `remaining < 1` means no more real calls.
      // Inject a non-error tool_result so the model keeps reasoning, skip
      // the handler entirely.
      if (sessionBudget && sessionBudget.remaining < 1) {
        skippedByBudget = true;
        content = SESSION_EXHAUSTED_TOOL_RESULT;
        if (!sessionBudget._exhaustedBroadcast) {
          sessionBudget._exhaustedBroadcast = true;
          emit(sessionId, { type: 'session-search-budget-exhausted', agentId, sessionId });
          log.warn({ sessionId, agentId, tool: block.name }, 'session search budget exhausted');
          recordSafe({
            ...metricsBase,
            eventType: 'session_budget_exhausted',
          });
        }
      } else {
        // Per-call query truncation. Only applies to tools whose input has a
        // `queries` array — non-search tools (escalate_to_human) are
        // unaffected.
        if (maxQueriesPerCall != null
            && Array.isArray(effectiveInput.queries)
            && effectiveInput.queries.length > maxQueriesPerCall) {
          const emitted = effectiveInput.queries.length;
          effectiveInput = { ...effectiveInput, queries: effectiveInput.queries.slice(0, maxQueriesPerCall) };
          truncatedThisCall = true;
          log.warn({ sessionId, agentId, tool: block.name, emitted, allowed: maxQueriesPerCall }, 'tool budget truncated');
          emit(sessionId, { type: 'agent-tool-budget-truncated', agentId, tool: block.name, emitted, allowed: maxQueriesPerCall, sessionId });
          emit(sessionId, { type: 'scout-tool-budget-truncated', agentId, tool: block.name, emitted, allowed: maxQueriesPerCall, sessionId });
          recordSafe({
            ...metricsBase,
            eventType: 'budget_truncation',
            queriesEmitted: emitted,
            queriesExecuted: maxQueriesPerCall,
            truncated: true,
          });
        }

        const tH0 = Date.now();
        try {
          if (!handler) throw new Error(`no handler registered for tool "${block.name}"`);
          const out = await handler(effectiveInput, { sessionId, agentId, round: rounds });
          content = typeof out === 'string' ? out : JSON.stringify(out);

          // Consume session budget after a successful search-shaped call.
          if (sessionBudget && Array.isArray(effectiveInput.queries)) {
            const consumed = sessionBudget.consume(effectiveInput.queries.length);
            emit(sessionId, { type: 'agent-search-used', agentId, queryCount: consumed, sessionBudgetRemaining: sessionBudget.remaining, sessionId });
            log.info({ sessionId, agentId, tool: block.name, consumed, sessionBudgetRemaining: sessionBudget.remaining }, 'agent search used');
          }
        } catch (err) {
          is_error = true;
          content = String((err && err.message) || err);
          handlerError = content;
          log.error({ sessionId, agentId, tool: block.name, err: content }, 'tool handler threw');
          recordSafe({
            ...metricsBase,
            eventType: 'handler_error',
            error: content,
          });
        } finally {
          handlerLatencyMs = Date.now() - tH0;
        }
      }

      // Per-invocation tool_call row. Only search-shaped tools (tool_use
      // block with an `input.queries` array) are instrumented here;
      // escalate_to_human piggy-backs on the same loop and does not
      // emit. `skippedByBudget` is still counted — the canary needs to
      // see that the LLM wanted to search even when the handler was
      // skipped.
      if (Array.isArray(block.input && block.input.queries)) {
        const executed = skippedByBudget
          ? 0
          : (Array.isArray(effectiveInput.queries) ? effectiveInput.queries.length : 0);
        recordSafe({
          ...metricsBase,
          eventType: 'tool_call',
          queriesEmitted: originalQueries,
          queriesExecuted: executed,
          truncated: truncatedThisCall,
          latencyMs: handlerLatencyMs,
          error: handlerError,
        });
      }

      const invocation = { round: rounds, toolName: block.name, toolUseId: block.id, input: effectiveInput, output: content, is_error };
      if (skippedByBudget) invocation.skippedByBudget = true;
      toolInvocations.push(invocation);
      realResults.push({ type: 'tool_result', tool_use_id: block.id, is_error, content });

      const queryCount = Array.isArray(effectiveInput.queries) ? effectiveInput.queries.length : undefined;
      emit(sessionId, { type: 'scout-tool-round', agentId, round: rounds, toolName: block.name, queryCount, sessionId });
    }

    log.info({ sessionId, agentId, round: rounds, toolUseCount: toolUses.length, latencyMs }, 'tool loop round');

    if (rounds >= maxRounds) {
      // Terminal round: feed terminal tool_results instead of real ones so
      // the next LLM call knows to synthesize.
      budgetExhausted = true;
      log.warn({ sessionId, agentId, rounds }, 'tool loop: budget exhausted, forcing synthesis');
      emit(sessionId, { type: 'scout-tool-budget-exhausted', agentId, rounds, sessionId });
      const terminalResults = toolUses.map(b => ({
        type: 'tool_result',
        tool_use_id: b.id,
        is_error: false,
        content: TERMINAL_TOOL_RESULT,
      }));
      working.push({ role: 'user', content: terminalResults });
    } else {
      working.push({ role: 'user', content: realResults });
    }
  }

  // Exceeded LOOP_SAFETY. Should not happen with well-behaved LLMs; return
  // whatever we have so the caller can log & recover.
  log.error({ sessionId, agentId, rounds }, 'tool loop: safety bound exceeded');
  return {
    finalMessage: null,
    workingMessages: working,
    rounds,
    toolInvocations,
    budgetExhausted,
    usage,
    model: usedModel,
    route: usedRoute,
  };
}

module.exports = { runWithTools, TERMINAL_TOOL_RESULT, SESSION_EXHAUSTED_TOOL_RESULT };
