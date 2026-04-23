/**
 * Unit tests for the Session 5 tool-loop budget extensions.
 *
 * Gates:
 *   - maxQueriesPerCall truncates input.queries[] before handler runs;
 *     emits agent-tool-budget-truncated (and legacy scout variant);
 *     truncation is NOT counted as a round.
 *   - sessionBudget.remaining < 1 skips the handler entirely and injects
 *     a non-error tool_result; fires session-search-budget-exhausted exactly once.
 *   - Successful calls consume sessionBudget by the truncated query count.
 *   - agent-search-used broadcasts on each search-shaped handler invocation.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LOOP = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');
const CFG = path.join(REPO_ROOT, 'lib', 'agents', 'search-config.js');

async function runScript(body, env = {}) {
  const script = `
    'use strict';
    const L = require(${JSON.stringify(LOOP)});
    const C = require(${JSON.stringify(CFG)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000, env });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('tool-loop: per-call truncation', () => {
  test('emits 5 queries with maxQueriesPerCall=2 → handler sees 2, broadcast fires', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const llmCall = async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['a', 'b', 'c', 'd', 'e'] } }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
        };
        const events = [];
        let handlerSawQueries = null;
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { web_search: async (input) => { handlerSawQueries = input.queries; return 'ok'; } },
          maxRounds: 3,
          maxQueriesPerCall: 2,
          broadcast: (sid, data) => events.push(data),
          sessionId: 'S', agentId: 'red-teamer',
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls, rounds: out.rounds,
          handlerSawQueries,
          truncateGeneric: events.find(e => e.type === 'agent-tool-budget-truncated'),
          truncateLegacy: events.find(e => e.type === 'scout-tool-budget-truncated'),
          invocation: out.toolInvocations[0],
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.handlerSawQueries, ['a', 'b'], 'handler sees truncated queries');
    assert.ok(parsed.truncateGeneric, 'agent-tool-budget-truncated fires');
    assert.equal(parsed.truncateGeneric.emitted, 5);
    assert.equal(parsed.truncateGeneric.allowed, 2);
    assert.ok(parsed.truncateLegacy, 'legacy scout-tool-budget-truncated fires for back-compat');
    assert.equal(parsed.llmCalls, 2);
    assert.equal(parsed.rounds, 2, 'truncation does NOT consume a round; LLM called twice (1 tool + 1 synth)');
    assert.deepEqual(parsed.invocation.input.queries, ['a', 'b']);
  });

  test('maxQueriesPerCall unset → no truncation, no broadcast', async () => {
    const { parsed } = await runScript(`
        const llmCall = async () => {
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['a', 'b', 'c'] } }],
          };
        };
        // Add an end_turn to let the loop exit after one call.
        let c = 0;
        const llm2 = async (req) => { c++; return c === 1 ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['a', 'b', 'c'] } }] } : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'k' }] }; };
        const events = [];
        let seen = null;
        await L.runWithTools({
          llmCall: llm2, model: 'm', system: 's', messages: [],
          tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { web_search: async (input) => { seen = input.queries; return 'ok'; } },
          maxRounds: 3,
          broadcast: (sid, data) => events.push(data),
          sessionId: 'S', agentId: 'a',
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          seen,
          truncated: events.some(e => e.type === 'agent-tool-budget-truncated'),
        }));
    `);
    assert.deepEqual(parsed.seen, ['a', 'b', 'c']);
    assert.equal(parsed.truncated, false);
  });
});

describe('tool-loop: session budget exhaustion', () => {
  test('remaining=0 → handler skipped, non-error tool_result injected, exhausted broadcast fires once', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const llmCall = async () => {
          llmCalls++;
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['x'] } }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'synthesized' }] };
        };
        let handlerCalls = 0;
        const events = [];
        const budget = C.makeSessionBudget(0); // already at 0
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { web_search: async () => { handlerCalls++; return 'REAL'; } },
          maxRounds: 3,
          maxQueriesPerCall: 3,
          sessionBudget: budget,
          broadcast: (sid, data) => events.push(data),
          sessionId: 'S', agentId: 'specialist-legal',
        });
        const inv = out.toolInvocations[0];
        // workingMessages: [0]=assistant(tool_use), [1]=user(tool_result), [2]=assistant(end_turn)
        const toolResult = out.workingMessages[1].content[0];
        process.stdout.write(JSON.stringify({
          ok: true,
          handlerCalls,
          skippedByBudget: inv.skippedByBudget,
          invOutput: inv.output,
          toolResultIsError: toolResult.is_error,
          toolResultContent: toolResult.content,
          exhaustedCount: events.filter(e => e.type === 'session-search-budget-exhausted').length,
          finalText: out.finalMessage.content[0].text,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.handlerCalls, 0, 'handler was NOT invoked');
    assert.equal(parsed.skippedByBudget, true);
    assert.equal(parsed.toolResultIsError, false);
    assert.match(parsed.toolResultContent, /Session search budget exhausted/);
    assert.equal(parsed.exhaustedCount, 1, 'session-search-budget-exhausted fires exactly once');
    assert.equal(parsed.finalText, 'synthesized');
  });

  test('budget starts at 5; three calls of 3+2 then a 1 → third call skipped with 0 remaining', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const plans = [
          ['a', 'b', 'c'],  // 3 queries → remaining 5→2
          ['d', 'e'],        // 2 queries → remaining 2→0
          ['f'],             // skipped (remaining < 1)
        ];
        const llmCall = async () => {
          llmCalls++;
          const idx = llmCalls - 1;
          if (idx < plans.length) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_' + llmCalls, name: 'web_search', input: { queries: plans[idx] } }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'end' }] };
        };
        const events = [];
        let handlerCalls = 0;
        const budget = C.makeSessionBudget(5);
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { web_search: async () => { handlerCalls++; return 'R'; } },
          maxRounds: 10,
          maxQueriesPerCall: 5,
          sessionBudget: budget,
          broadcast: (sid, data) => events.push(data),
          sessionId: 'S', agentId: 'research-scout',
        });
        const used = events.filter(e => e.type === 'agent-search-used');
        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls,
          handlerCalls,
          skipped: out.toolInvocations.filter(i => i.skippedByBudget).length,
          remaining: budget.remaining,
          consumed: budget.consumed,
          exhaustedEvents: events.filter(e => e.type === 'session-search-budget-exhausted').length,
          searchUsedCounts: used.map(e => e.queryCount),
          searchUsedRemainings: used.map(e => e.sessionBudgetRemaining),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.handlerCalls, 2, 'handler invoked twice before exhaustion');
    assert.equal(parsed.skipped, 1, 'third tool_use skipped by budget');
    assert.equal(parsed.remaining, 0);
    assert.equal(parsed.consumed, 5);
    assert.equal(parsed.exhaustedEvents, 1, 'session-search-budget-exhausted fires exactly once');
    assert.deepEqual(parsed.searchUsedCounts, [3, 2]);
    assert.deepEqual(parsed.searchUsedRemainings, [2, 0]);
  });

  test('agent-search-used broadcasts only for search-shaped calls (no queries → no event)', async () => {
    const { parsed } = await runScript(`
        let c = 0;
        const llmCall = async () => {
          c++;
          if (c === 1) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'escalate_to_human', input: { question: 'q?' } }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
        };
        const events = [];
        const budget = C.makeSessionBudget(10);
        await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'escalate_to_human', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { escalate_to_human: async () => 'queued' },
          maxRounds: 3,
          sessionBudget: budget,
          broadcast: (sid, data) => events.push(data),
          sessionId: 'S', agentId: 'a',
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          searchUsed: events.filter(e => e.type === 'agent-search-used').length,
          remaining: budget.remaining,
        }));
    `);
    assert.equal(parsed.searchUsed, 0, 'no agent-search-used event for non-query tool');
    assert.equal(parsed.remaining, 10, 'budget untouched by escalate_to_human');
  });
});
