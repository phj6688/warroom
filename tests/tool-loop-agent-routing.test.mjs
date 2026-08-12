/**
 * The tool-loop path must resolve the same route as the prose path.
 *
 * lib/llm.js resolves an agent's provider route from its agentId. runWithTools
 * owns the LLM call for every search-enabled agent, so if it drops agentId on
 * the way to llmCall, those agents silently ignore their configured route and
 * fall back to the env default. On 2026-08-11 that sent research-scout,
 * quantitative-expert, red-teamer and every specialist to the subscription
 * gateway instead of OpenRouter, and 57 of 110 agent turns died in a
 * model_cooldown storm while the configured provider sat idle.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');

describe('tool-loop agent routing', () => {
  test('forwards agentId to llmCall so per-agent routing resolves', async () => {
    const { stdout, stderr } = await runNodeScript(`
      'use strict';
      const L = require(${JSON.stringify(LIB)});
      (async () => {
        const seen = [];
        const llmCall = async (args) => {
          seen.push(args);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
        };
        await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [], toolHandlers: {}, maxRounds: 3,
          sessionId: 'S', agentId: 'research-scout',
        });
        process.stdout.write(JSON.stringify({ ok: true, agentIds: seen.map(a => a.agentId) }));
      })().catch(err => {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
        process.exitCode = 1;
      });
    `);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.agentIds, ['research-scout'], 'llmCall receives the agentId');
  });

  test('forwards agentId on every round, not just the first', async () => {
    const { stdout, stderr } = await runNodeScript(`
      'use strict';
      const L = require(${JSON.stringify(LIB)});
      (async () => {
        const seen = [];
        let n = 0;
        const llmCall = async (args) => {
          seen.push(args.agentId);
          n++;
          if (n === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }] };
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] };
        };
        await L.runWithTools({
          llmCall, model: 'm', system: 's', messages: [],
          tools: [{ name: 'noop', description: 'x', input_schema: { type: 'object', properties: {} } }],
          toolHandlers: { noop: async () => 'ok' },
          maxRounds: 3, sessionId: 'S', agentId: 'red-teamer',
        });
        process.stdout.write(JSON.stringify({ ok: true, seen }));
      })().catch(err => {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
        process.exitCode = 1;
      });
    `);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.seen.length, 2, 'two rounds ran');
    assert.deepEqual(parsed.seen, ['red-teamer', 'red-teamer'], 'agentId survives every round');
  });
});
