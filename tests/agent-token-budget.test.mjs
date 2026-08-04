// Reasoning models (claude-opus-5 and friends) spend the output budget on
// thinking tokens BEFORE emitting any text. A budget that is merely "generous"
// for a non-reasoning model comes back finish_reason=length with empty content,
// which _callOnce throws as "Gateway returned empty response" — the gateway
// itself being perfectly healthy. The old default of 1500 sat in that dead zone
// and failed non-deterministically, so a phase would silently lose most of its
// agents. Measured on claude-opus-5 via CLIProxy: 1024 and 1500 return empty,
// 4096 and above return text.
//
// These assert the EFFECTIVE runtime budget, not the source text: a test that
// greps the implementation can pass while the feature is broken.
//
// Each case runs in an isolated child process because llm.js reads the env once
// at module load. `runNodeScript` merges process.env, so any case that needs the
// variable absent must delete it inside the child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const readBudget = `
  delete process.env.AGENT_MAX_TOKENS;
  if (RAW !== null) process.env.AGENT_MAX_TOKENS = RAW;
  const { AGENT_MAX_TOKENS } = require('./lib/llm');
  console.log('BUDGET=' + AGENT_MAX_TOKENS);
`;

async function effectiveBudget(raw) {
  const res = await runNodeScript(
    `const RAW = ${raw === null ? 'null' : JSON.stringify(raw)};\n${readBudget}`,
    {},
  );
  assert.equal(res.code, 0, res.stderr);
  const m = res.stdout.match(/BUDGET=(\d+)/);
  assert.ok(m, `no budget printed, got: ${res.stdout} ${res.stderr}`);
  return Number(m[1]);
}

test('unset AGENT_MAX_TOKENS gives a budget clear of the reasoning dead zone', async () => {
  const budget = await effectiveBudget(null);
  assert.equal(budget, 8000);
  assert.ok(budget >= 4096, `default ${budget} is inside the dead zone`);
});

test('a valid AGENT_MAX_TOKENS is honoured', async () => {
  assert.equal(await effectiveBudget('4096'), 4096);
  assert.equal(await effectiveBudget('16000'), 16000);
});

// The whole point of the fix is that 1500 must never come back by accident.
// parseInt would turn each of these into a dead-zone budget.
test('malformed AGENT_MAX_TOKENS falls back instead of silently restoring the dead zone', async () => {
  for (const bad of ['1500oops', 'abc', '0', '-1', '', '  ', '12.5', '0x1f4']) {
    const budget = await effectiveBudget(bad);
    assert.equal(budget, 8000, `AGENT_MAX_TOKENS=${JSON.stringify(bad)} should fall back to 8000`);
    assert.notEqual(budget, 1500, `AGENT_MAX_TOKENS=${JSON.stringify(bad)} restored the dead zone`);
  }
});

// Both agent call paths must actually use the budget, not just define it.
test('both agent call paths default to the effective budget', async () => {
  const res = await runNodeScript(`
    const assert = require('assert');
    delete process.env.AGENT_MAX_TOKENS;
    const { callAnthropic, callAnthropicWithTools, AGENT_MAX_TOKENS } = require('./lib/llm');
    for (const [name, fn] of [['callAnthropic', callAnthropic], ['callAnthropicWithTools', callAnthropicWithTools]]) {
      const src = fn.toString();
      assert.ok(/maxTokens = AGENT_MAX_TOKENS/.test(src), name + ' does not default to AGENT_MAX_TOKENS');
    }
    assert.ok(AGENT_MAX_TOKENS >= 4096, 'exported budget is inside the dead zone');
    console.log('OK');
  `, {});
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /OK/);
});
