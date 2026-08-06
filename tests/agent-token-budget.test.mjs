// An agent turn is uncapped by default.
//
// Any finite output budget is a guess at how many tokens a model spends on
// reasoning before its first character of text, and a low guess does not
// truncate the answer, it erases it: finish_reason=length with empty content,
// which _callOnce throws as "Gateway returned empty response". 1500 did that on
// claude-opus-5 via CLIProxy. The 8000 that replaced it did the same on
// moonshotai/kimi-k3 via OpenRouter, measured at 8000 completion tokens and
// zero characters of content, which is the model every agent is routed to.
// Raising the number again just relocates the cliff, so there is no number.
//
// These assert the EFFECTIVE request the provider receives, not the source
// text: a test that greps the implementation can pass while the feature is
// broken.
//
// Each case runs in an isolated child process because llm.js reads the env once
// at module load. `runNodeScript` merges process.env, so any case that needs the
// variable absent must delete it inside the child.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LLM = path.join(REPO_ROOT, 'lib', 'llm.js');

const readBudget = `
  delete process.env.AGENT_MAX_TOKENS;
  if (RAW !== null) process.env.AGENT_MAX_TOKENS = RAW;
  const { AGENT_MAX_TOKENS } = require('./lib/llm');
  console.log('BUDGET=' + JSON.stringify(AGENT_MAX_TOKENS));
`;

async function effectiveBudget(raw) {
  const res = await runNodeScript(
    `const RAW = ${raw === null ? 'null' : JSON.stringify(raw)};\n${readBudget}`,
    {},
  );
  assert.equal(res.code, 0, res.stderr);
  const m = res.stdout.match(/BUDGET=(.+)/);
  assert.ok(m, `no budget printed, got: ${res.stdout} ${res.stderr}`);
  return JSON.parse(m[1]);
}

test('unset AGENT_MAX_TOKENS leaves the turn uncapped', async () => {
  assert.equal(await effectiveBudget(null), null);
});

test('a valid AGENT_MAX_TOKENS is honoured', async () => {
  assert.equal(await effectiveBudget('4096'), 4096);
  assert.equal(await effectiveBudget('16000'), 16000);
});

// A wrong number is worse than no number: it produces a silently empty agent.
// parseInt would turn several of these into exactly the budget that fails.
test('malformed AGENT_MAX_TOKENS stays uncapped instead of resolving to a number', async () => {
  for (const bad of ['1500oops', 'abc', '0', '-1', '', '  ', '12.5', '0x1f4', 'unlimited']) {
    const budget = await effectiveBudget(bad);
    assert.equal(budget, null, `AGENT_MAX_TOKENS=${JSON.stringify(bad)} should stay uncapped`);
  }
});

// The behavioural half: what actually reaches the provider. The stub records
// every request body, so an omitted key and a key set to null are distinct.
const captureGateway = `
  const http = require('http');
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      seen.push(JSON.parse(body));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  srv.unref();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + srv.address().port + '/v1';
  process.env.OPENAI_API_KEY = 'stub-key';
  process.env.MODEL = 'stub/model';
`;

// Exercises all three call paths an agent turn can take: the plain wrapper, the
// tool-aware wrapper, and the raw path the search tool-loop drives.
async function bodiesFromEveryCallPath(env) {
  const res = await runNodeScript(`
    'use strict';
    (async () => {
      try {
${captureGateway}
        const { callAnthropic, callAnthropicWithTools, callLLMRaw } = require(${JSON.stringify(LLM)});
        const msgs = [{ role: 'user', content: 'hi' }];
        await callAnthropic('sys', msgs, 'process-architect');
        await callAnthropicWithTools('sys', msgs, 'process-architect', []);
        await callLLMRaw({ model: 'stub/model', system: 'sys', messages: msgs, agentId: 'process-architect' });
        process.stdout.write(JSON.stringify(seen));
      } catch (err) {
        process.stdout.write(JSON.stringify({ error: err.message }));
        process.exitCode = 1;
      }
    })();
  `, { env, timeoutMs: 20_000 });
  assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
  const bodies = JSON.parse(res.stdout);
  assert.equal(bodies.length, 3, `expected 3 captured requests, got ${res.stdout}`);
  return bodies;
}

test('by default no call path sends max_tokens to an OpenAI-compatible provider', async () => {
  const bodies = await bodiesFromEveryCallPath({ AGENT_MAX_TOKENS: '' });
  for (const [i, body] of bodies.entries()) {
    assert.ok(
      !('max_tokens' in body),
      `call path ${i} sent max_tokens=${body.max_tokens}; OpenRouter would cap the agent at that`,
    );
  }
});

test('an explicit AGENT_MAX_TOKENS reaches every call path', async () => {
  const bodies = await bodiesFromEveryCallPath({ AGENT_MAX_TOKENS: '12345' });
  for (const [i, body] of bodies.entries()) {
    assert.equal(body.max_tokens, 12345, `call path ${i} ignored the configured cap`);
  }
});
