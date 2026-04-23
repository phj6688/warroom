/**
 * Emission-site tests for lib/agents/tool-loop.js metrics plumbing.
 *
 * The sink is mocked — we verify the call sequence (event_type, path,
 * counts, error). Real DB writes are covered by search-metrics.test.mjs.
 *
 * Gates (from §6.3):
 *   - One tool_use turn → N `tool_call` events matching handler invocations.
 *   - Truncation turn → `budget_truncation` row AND `tool_call` row.
 *   - Budget-exhausted turn → `session_budget_exhausted` exactly once,
 *     even when multiple subsequent tool_uses are skipped.
 *   - Handler-throw turn → `handler_error` with the message.
 *   - tool_call is emitted for search-shaped tools only (escalate_to_human
 *     plumbed through same loop does NOT emit).
 *
 * Note: `agent_turn_complete` is emitted by server.js (the host), NOT by
 * tool-loop. It's covered by the integration smoke + canary-views tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LOOP = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');
const CFG = path.join(REPO_ROOT, 'lib', 'agents', 'search-config.js');

async function runScript(body) {
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
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('metrics emission: single tool_use turn', () => {
  test('one tool_call event; no truncation, no error, no exhaustion', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const events = [];
      const sink = { record: (e) => events.push(e) };
      let calls = 0;
      const llmCall = async () => {
        calls++;
        if (calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['a', 'b'] } }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      };
      await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { web_search: async () => 'result' },
        maxRounds: 3,
        sessionId: 'S', agentId: 'research-scout',
        metricsSink: sink, agentTier: 'A', provider: 'tavily',
      });
      process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const byType = parsed.events.reduce((m, e) => { (m[e.eventType] ||= []).push(e); return m; }, {});
    assert.equal((byType.tool_call || []).length, 1);
    assert.equal(byType.tool_call[0].queriesEmitted, 2);
    assert.equal(byType.tool_call[0].queriesExecuted, 2);
    assert.equal(byType.tool_call[0].truncated, false);
    assert.equal(byType.tool_call[0].provider, 'tavily');
    assert.equal(byType.tool_call[0].agentTier, 'A');
    assert.equal(byType.tool_call[0].error, null);
    assert.equal((byType.budget_truncation || []).length, 0);
    assert.equal((byType.handler_error || []).length, 0);
    assert.equal((byType.session_budget_exhausted || []).length, 0);
  });
});

describe('metrics emission: truncation', () => {
  test('truncation emits BOTH budget_truncation and tool_call rows', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const events = [];
      const sink = { record: (e) => events.push(e) };
      let calls = 0;
      const llmCall = async () => {
        calls++;
        if (calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['a','b','c','d','e'] } }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      };
      await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { web_search: async () => 'result' },
        maxRounds: 3,
        maxQueriesPerCall: 2,
        sessionId: 'S', agentId: 'red-teamer',
        metricsSink: sink, agentTier: 'B', provider: 'tavily',
      });
      process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const types = parsed.events.map(e => e.eventType);
    assert.ok(types.includes('budget_truncation'));
    assert.ok(types.includes('tool_call'));
    const trunc = parsed.events.find(e => e.eventType === 'budget_truncation');
    const call = parsed.events.find(e => e.eventType === 'tool_call');
    assert.equal(trunc.queriesEmitted, 5);
    assert.equal(trunc.queriesExecuted, 2);
    assert.equal(trunc.truncated, true);
    assert.equal(call.queriesEmitted, 5);
    assert.equal(call.queriesExecuted, 2);
    assert.equal(call.truncated, true);
  });
});

describe('metrics emission: session budget exhaustion', () => {
  test('session_budget_exhausted fires exactly once even when multiple tool_uses are skipped', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const events = [];
      const sink = { record: (e) => events.push(e) };
      let calls = 0;
      // Plan: three tool_uses in a row, budget=0 from the start.
      const plans = [['a'], ['b'], ['c']];
      const llmCall = async () => {
        calls++;
        const idx = calls - 1;
        if (idx < plans.length) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_' + calls, name: 'web_search', input: { queries: plans[idx] } }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'fin' }] };
      };
      const budget = C.makeSessionBudget(0);
      await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { web_search: async () => 'x' },
        maxRounds: 10,
        sessionBudget: budget,
        sessionId: 'S', agentId: 'specialist-legal',
        metricsSink: sink, agentTier: 'C', provider: 'tavily',
      });
      process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    // The loop only iterates as long as LLM returns tool_use. Here the
    // first tool_use triggers exhausted, the handler is skipped,
    // exhausted row is emitted ONCE. The next LLM call still returns
    // tool_use; the loop hits the "post-terminal still emitted tool_use"
    // guard and forces return. So we should see exactly 1 exhausted row.
    const exhausted = parsed.events.filter(e => e.eventType === 'session_budget_exhausted');
    assert.equal(exhausted.length, 1);
  });
});

describe('metrics emission: handler error', () => {
  test('throwing handler produces handler_error row with message', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const events = [];
      const sink = { record: (e) => events.push(e) };
      let calls = 0;
      const llmCall = async () => {
        calls++;
        if (calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['q'] } }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
      };
      await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'web_search', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { web_search: async () => { throw new Error('net blip'); } },
        maxRounds: 3,
        sessionId: 'S', agentId: 'research-scout',
        metricsSink: sink, agentTier: 'A', provider: 'tavily',
      });
      process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const err = parsed.events.find(e => e.eventType === 'handler_error');
    const call = parsed.events.find(e => e.eventType === 'tool_call');
    assert.ok(err, 'handler_error row emitted');
    assert.match(err.error, /net blip/);
    assert.ok(call, 'tool_call row still emitted for a thrown handler');
    assert.match(call.error, /net blip/);
  });
});

describe('metrics emission: non-search tool does not fire tool_call', () => {
  test('escalate_to_human tool_use generates no tool_call event', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const events = [];
      const sink = { record: (e) => events.push(e) };
      let calls = 0;
      const llmCall = async () => {
        calls++;
        if (calls === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'escalate_to_human', input: { question: 'q?' } }] };
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      };
      await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'escalate_to_human', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { escalate_to_human: async () => 'queued' },
        maxRounds: 3,
        sessionId: 'S', agentId: 'red-teamer',
        metricsSink: sink, agentTier: 'B', provider: 'tavily',
      });
      process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.events.filter(e => e.eventType === 'tool_call').length, 0);
  });
});
