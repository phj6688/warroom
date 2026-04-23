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
// Round-count semantics (spec-fixed, see gate 7):
//   - Each LLM call increments `rounds`.
//   - maxRounds=N caps handler invocations at N.
//   - On round N's tool_use, handlers DO run for side-effects AND their
//     output is recorded in `toolInvocations`, but the tool_result blocks
//     fed back to the LLM are OVERWRITTEN with a terminal
//     "Search budget exhausted…" note per tool_use_id. Then one more LLM
//     call (the capped synthesis) fires and the loop returns.
//   - Net: with maxRounds=3 and an LLM that always emits tool_use, handlers
//     are invoked exactly 3 times and the LLM is called exactly 4 times.
//     Handler output on the 3rd round is wasted work — deliberate trade-off
//     for a simple, predictable count guarantee. If the handler is
//     expensive in practice, Session 5+ can add a pre-gate to skip it.

'use strict';

const TERMINAL_TOOL_RESULT =
  'Search budget exhausted for this turn. Synthesize with what you have.';

async function runWithTools({
  llmCall,
  model,
  system,
  messages,
  tools,
  toolHandlers,
  maxRounds = 3,
  maxTokens,
  broadcast,
  sessionId,
  agentId,
  logger,
}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  let working = [...messages];
  let rounds = 0;
  const toolInvocations = [];
  let budgetExhausted = false;

  // Safety bound. maxRounds + 1 for the capped-synthesis call plus a tiny
  // slack for unusually verbose scouts. We return once we see a terminal
  // stop_reason or exceed this.
  const LOOP_SAFETY = maxRounds + 2;

  for (let iter = 0; iter < LOOP_SAFETY; iter++) {
    rounds += 1;
    const t0 = Date.now();
    const response = await llmCall({ model, system, messages: working, tools, maxTokens });
    const latencyMs = Date.now() - t0;

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
      try {
        if (!handler) throw new Error(`no handler registered for tool "${block.name}"`);
        const out = await handler(block.input || {}, { sessionId, agentId, round: rounds });
        content = typeof out === 'string' ? out : JSON.stringify(out);
      } catch (err) {
        is_error = true;
        content = String((err && err.message) || err);
        log.error({ sessionId, agentId, tool: block.name, err: content }, 'tool handler threw');
      }
      toolInvocations.push({ round: rounds, toolName: block.name, toolUseId: block.id, input: block.input, output: content, is_error });
      realResults.push({ type: 'tool_result', tool_use_id: block.id, is_error, content });
      emit(sessionId, { type: 'scout-tool-round', agentId, round: rounds, toolName: block.name, queryCount: Array.isArray(block.input?.queries) ? block.input.queries.length : undefined, sessionId });
    }

    log.info({ sessionId, agentId, round: rounds, queryCount: toolUses.length, latencyMs }, 'tool loop round');

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
  };
}

module.exports = { runWithTools, TERMINAL_TOOL_RESULT };
