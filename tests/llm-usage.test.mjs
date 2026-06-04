/**
 * HLB-152 R1 — the LLM wrappers thread usage out of every call.
 *
 * lib/llm.js talks to a gateway (OpenAI-compatible) or the Anthropic SDK. The
 * tests stub the gateway via a local HTTP server so no real model is hit, then
 * assert:
 *   - callAnthropic invokes its onUsage callback with normalized usage.
 *   - callAnthropicWithTools returns { text, toolCalls, usage }.
 *   - the tool-loop (lib/agents/tool-loop.js) returns usage summed across ALL
 *     round-trips, equal to the sum of the per-round usage objects.
 *
 * Follows the runNodeScript subprocess convention — no direct lib import.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LLM = path.join(REPO_ROOT, 'lib', 'llm.js');
const LOOP = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');

async function runScript(body, env = {}) {
  const script = `
    'use strict';
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 20_000, env });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

// A tiny gateway stub. Returns a fixed completion + usage. Reused by the
// callAnthropic/callAnthropicWithTools tests.
function gatewayStubSnippet(usage) {
  return `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' }],
          usage: ${JSON.stringify(usage)},
        }));
      });
    });
    srv.unref();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + port + '/v1';
    process.env.OPENAI_API_KEY = 'stub-key';
  `;
}

describe('llm wrappers: usage propagation', () => {
  test('callAnthropic invokes onUsage with normalized usage', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      ${gatewayStubSnippet({ prompt_tokens: 70, completion_tokens: 30, total_tokens: 100 })}
      const { callAnthropic } = require(${JSON.stringify(LLM)});
      let seen = null;
      const text = await callAnthropic('sys', [{ role: 'user', content: 'hi' }], 'agent-x', 100, (u) => { seen = u; });
      process.stdout.write(JSON.stringify({ ok: true, text, seen }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.text, 'stub reply', 'callAnthropic still returns the bare string');
    assert.ok(parsed.seen, 'onUsage was invoked');
    assert.equal(parsed.seen.input_tokens, 70);
    assert.equal(parsed.seen.output_tokens, 30);
    assert.equal(parsed.seen.total_tokens, 100);
  });

  test('callAnthropicWithTools returns { text, toolCalls, usage }', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      ${gatewayStubSnippet({ prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 })}
      const { callAnthropicWithTools } = require(${JSON.stringify(LLM)});
      const out = await callAnthropicWithTools('sys', [{ role: 'user', content: 'hi' }], 'agent-x', [], 100);
      process.stdout.write(JSON.stringify({ ok: true, out }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.out.text, 'stub reply');
    assert.ok(Array.isArray(parsed.out.toolCalls), 'toolCalls preserved');
    assert.ok(parsed.out.usage, 'usage present on the return');
    assert.equal(parsed.out.usage.input_tokens, 11);
    assert.equal(parsed.out.usage.output_tokens, 4);
    assert.equal(parsed.out.usage.total_tokens, 15);
  });
});

describe('tool-loop: usage summed across round-trips (R1)', () => {
  test('returned usage equals the sum of every round-trip usage object', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const L = require(${JSON.stringify(LOOP)});
      // Three LLM calls: two tool_use rounds then a terminal end_turn. Each
      // reports its own usage; the loop must sum all three.
      const usages = [
        { input_tokens: 100, output_tokens: 20 },
        { input_tokens: 150, output_tokens: 35 },
        { input_tokens: 60, output_tokens: 90 },
      ];
      let i = 0;
      const llmCall = async () => {
        const usage = usages[i];
        const last = i === usages.length - 1;
        i++;
        if (last) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage };
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_' + i, name: 'noop', input: {} }], usage };
      };
      const out = await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { noop: async () => 'ok' },
        maxRounds: 5,
      });
      process.stdout.write(JSON.stringify({ ok: true, usage: out.usage, rounds: out.rounds }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.rounds, 3, 'three LLM calls total');
    assert.ok(parsed.usage, 'loop returns a summed usage');
    // Sum of inputs: 100 + 150 + 60 = 310; outputs: 20 + 35 + 90 = 145.
    assert.equal(parsed.usage.input_tokens, 310);
    assert.equal(parsed.usage.output_tokens, 145);
    assert.equal(parsed.usage.total_tokens, 455);
  });

  test('missing per-round usage is treated as zero, not a throw', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const L = require(${JSON.stringify(LOOP)});
      let i = 0;
      const llmCall = async () => {
        i++;
        if (i === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] }; // no usage
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 5, output_tokens: 7 } };
      };
      const out = await L.runWithTools({
        llmCall, model: 'm', system: 's', messages: [],
        tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
        toolHandlers: { noop: async () => 'ok' },
      });
      process.stdout.write(JSON.stringify({ ok: true, usage: out.usage }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.usage.input_tokens, 5);
    assert.equal(parsed.usage.output_tokens, 7);
    assert.equal(parsed.usage.total_tokens, 12);
  });
});
