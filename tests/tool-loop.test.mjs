/**
 * Unit tests for lib/agents/tool-loop.js.
 *
 * Gates (Session 4 §6.2):
 *   - stop_reason="end_turn" on first call → 1 LLM call, rounds=1
 *   - Single tool_use then end_turn → 2 LLM calls, handler invoked once
 *   - maxRounds=3 cap: handler 3×, LLM 4×, terminal tool_result injected
 *   - Handler throws → is_error tool_result, loop continues
 *   - Multiple tool_use blocks in one response → both handlers invoked
 *
 * Follows the runNodeScript subprocess convention — no direct lib import.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');

async function runScript(body) {
  const script = `
    'use strict';
    const L = require(${JSON.stringify(LIB)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('tool-loop: trivial termination', () => {
  test('LLM returns end_turn on first call → 1 LLM call, rounds=1, no handlers invoked', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const llmCall = async () => {
          llmCalls++;
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }] };
        };
        let handlerCalls = 0;
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { noop: async () => { handlerCalls++; return 'ok'; } },
        });
        process.stdout.write(JSON.stringify({ ok: true, llmCalls, handlerCalls, rounds: out.rounds, text: out.finalMessage.content[0].text }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.llmCalls, 1);
    assert.equal(parsed.handlerCalls, 0);
    assert.equal(parsed.rounds, 1);
    assert.equal(parsed.text, 'hello');
  });
});

describe('tool-loop: single tool_use then end_turn', () => {
  test('handler invoked once, LLM called twice, input threaded through', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const capturedMessages = [];
        const llmCall = async (req) => {
          llmCalls++;
          capturedMessages.push(req.messages.length);
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [
                { type: 'text', text: 'searching' },
                { type: 'tool_use', id: 'tu_1', name: 'noop', input: { x: 42 } },
              ],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
        };
        const handlerInputs = [];
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }],
          tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { noop: async (input) => { handlerInputs.push(input); return 'noop-output'; } },
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls, handlerCalls: handlerInputs.length,
          rounds: out.rounds,
          firstInput: handlerInputs[0],
          invCount: out.toolInvocations.length,
          invOutput: out.toolInvocations[0] && out.toolInvocations[0].output,
          growingMessages: capturedMessages,
          finalText: out.finalMessage.content[0].text,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.llmCalls, 2);
    assert.equal(parsed.handlerCalls, 1);
    assert.equal(parsed.rounds, 2);
    assert.deepEqual(parsed.firstInput, { x: 42 });
    assert.equal(parsed.invOutput, 'noop-output');
    assert.equal(parsed.finalText, 'done');
    // messages grow: round 1 sees just the user msg (len 1); round 2 sees
    // user + assistant(tool_use) + user(tool_result) = 3.
    assert.deepEqual(parsed.growingMessages, [1, 3]);
  });
});

describe('tool-loop: maxRounds cap', () => {
  test('LLM always emits tool_use: handler 3×, LLM 4×, terminal tool_result on round 3', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const seenMessages = [];
        const llmCall = async (req) => {
          llmCalls++;
          seenMessages.push(JSON.parse(JSON.stringify(req.messages)));
          // Always emit a fresh tool_use to prove the cap kicks in from our side.
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_' + llmCalls, name: 'noop', input: { n: llmCalls } }],
          };
        };
        let handlerCalls = 0;
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { noop: async () => { handlerCalls++; return 'real-' + handlerCalls; } },
          maxRounds: 3,
        });

        // Inspect the LAST messages the LLM saw on call 4: the final user
        // message must contain a terminal tool_result per outstanding
        // tool_use_id, not the real handler output.
        const lastSeen = seenMessages[seenMessages.length - 1];
        const lastUserMsg = lastSeen[lastSeen.length - 1];
        const terminalContents = (lastUserMsg.content || []).map(b => b.content);

        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls, handlerCalls,
          rounds: out.rounds,
          budgetExhausted: out.budgetExhausted,
          terminalContents,
          invOutputs: out.toolInvocations.map(i => i.output),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.handlerCalls, 3, 'handler called exactly 3 times');
    assert.equal(parsed.llmCalls, 4, 'LLM called exactly 4 times (3 rounds + capped synthesis)');
    assert.equal(parsed.rounds, 4, 'rounds counter reflects 4 LLM calls total');
    assert.equal(parsed.budgetExhausted, true);
    assert.equal(parsed.terminalContents.length, 1);
    assert.match(parsed.terminalContents[0], /Search budget exhausted for this turn/);
    // Handlers ran all 3 times, their outputs are recorded in toolInvocations
    // even when the terminal replaces the 3rd round's tool_result.
    assert.deepEqual(parsed.invOutputs, ['real-1', 'real-2', 'real-3']);
  });
});

describe('tool-loop: handler throw', () => {
  test('throwing handler → is_error tool_result, loop continues to end_turn', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const seenMessages = [];
        const llmCall = async (req) => {
          llmCalls++;
          seenMessages.push(JSON.parse(JSON.stringify(req.messages)));
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_x', name: 'flaky', input: {} }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'recovered' }] };
        };
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'flaky', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { flaky: async () => { throw new Error('network blip'); } },
        });
        const lastSeen = seenMessages[seenMessages.length - 1];
        const toolResultBlock = lastSeen[lastSeen.length - 1].content[0];
        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls, rounds: out.rounds,
          is_error: toolResultBlock.is_error,
          content: toolResultBlock.content,
          finalText: out.finalMessage.content[0].text,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.llmCalls, 2);
    assert.equal(parsed.is_error, true);
    assert.match(parsed.content, /network blip/);
    assert.equal(parsed.finalText, 'recovered');
  });
});

describe('tool-loop: multiple tool_use in one response', () => {
  test('both handlers invoked, tool_results keyed by tool_use_id', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const seenMessages = [];
        const llmCall = async (req) => {
          llmCalls++;
          seenMessages.push(JSON.parse(JSON.stringify(req.messages)));
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'id_a', name: 'search', input: { q: 'one' } },
                { type: 'tool_use', id: 'id_b', name: 'search', input: { q: 'two' } },
              ],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fin' }] };
        };
        const seen = [];
        const out = await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'search', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { search: async (input) => { seen.push(input.q); return 'R-' + input.q; } },
        });
        const lastSeen = seenMessages[seenMessages.length - 1];
        const toolResults = lastSeen[lastSeen.length - 1].content;
        process.stdout.write(JSON.stringify({
          ok: true,
          seen,
          toolResults: toolResults.map(b => ({ id: b.tool_use_id, content: b.content })),
          invCount: out.toolInvocations.length,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.seen, ['one', 'two']);
    assert.equal(parsed.invCount, 2);
    assert.deepEqual(parsed.toolResults, [
      { id: 'id_a', content: 'R-one' },
      { id: 'id_b', content: 'R-two' },
    ]);
  });
});

describe('tool-loop: observability', () => {
  test('broadcast fires scout-tool-round per round and scout-tool-budget-exhausted on cap', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        let llmCalls = 0;
        const llmCall = async () => {
          llmCalls++;
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu_' + llmCalls, name: 'noop', input: { queries: ['a', 'b'] } }],
          };
        };
        const events = [];
        await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { noop: async () => 'ok' },
          maxRounds: 3,
          broadcast: (sid, data) => events.push({ sid, ...data }),
          sessionId: 'S',
          agentId: 'scout',
        });
        process.stdout.write(JSON.stringify({
          ok: true,
          rounds: events.filter(e => e.type === 'scout-tool-round').length,
          exhausted: events.filter(e => e.type === 'scout-tool-budget-exhausted').length,
          firstRound: events.find(e => e.type === 'scout-tool-round'),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.rounds, 3, 'scout-tool-round fires exactly 3×');
    assert.equal(parsed.exhausted, 1, 'scout-tool-budget-exhausted fires exactly once');
    assert.equal(parsed.firstRound.toolName, 'noop');
    assert.equal(parsed.firstRound.queryCount, 2);
  });
});
