// Reasoning models (claude-opus-5 and friends) spend the output budget on
// thinking tokens BEFORE emitting any text. A budget that is merely "generous"
// for a non-reasoning model comes back finish_reason=length with empty content,
// which _callOnce throws as "Gateway returned empty response" — the gateway
// itself being perfectly healthy. The old default of 1500 sat in that dead zone
// and failed non-deterministically, so a phase would silently lose most of its
// agents. Measured on claude-opus-5 via CLIProxy: 1024 and 1500 return empty,
// 4096 and above return text.
//
// Run in an isolated child process so the env llm.js reads at module load is
// fully controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

// The default must clear the reasoning phase with real headroom.
test('agent turns default to a budget a reasoning model can clear', async () => {
  const res = await runNodeScript(`
    const assert = require('assert');
    const { callAnthropic, callAnthropicWithTools } = require('./lib/llm');
    // Read the default off the function signature: no network, no mocks.
    const sig = callAnthropic.toString();
    const sigTools = callAnthropicWithTools.toString();
    assert.ok(!/maxTokens = 1500/.test(sig), 'callAnthropic still hardcodes the 1500 dead-zone default');
    assert.ok(!/maxTokens = 1500/.test(sigTools), 'callAnthropicWithTools still hardcodes 1500');
    assert.ok(/maxTokens = AGENT_MAX_TOKENS/.test(sig), 'callAnthropic should default to AGENT_MAX_TOKENS');
    assert.ok(/maxTokens = AGENT_MAX_TOKENS/.test(sigTools), 'callAnthropicWithTools should default to AGENT_MAX_TOKENS');
    console.log('OK');
  `, {});
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});

// AGENT_MAX_TOKENS is the operator escape hatch; it must actually be read.
test('AGENT_MAX_TOKENS overrides the default budget', async () => {
  const res = await runNodeScript(`
    const assert = require('assert');
    const src = require('fs').readFileSync('./lib/llm.js', 'utf8');
    assert.ok(/process\\.env\\.AGENT_MAX_TOKENS/.test(src), 'AGENT_MAX_TOKENS must be read from env');
    const m = src.match(/AGENT_MAX_TOKENS \\|\\| '(\\d+)'/);
    assert.ok(m, 'AGENT_MAX_TOKENS needs a numeric string default');
    const fallback = parseInt(m[1], 10);
    assert.ok(fallback >= 4096, 'default budget ' + fallback + ' is inside the reasoning dead zone (<4096)');
    console.log('OK fallback=' + fallback);
  `, { AGENT_MAX_TOKENS: '4096' });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /OK fallback=\d+/);
});
