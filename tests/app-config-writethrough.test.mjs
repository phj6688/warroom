// HLB-342 fix 2 — app_settings write-through must be transactional: the DB
// upsert runs first, so a throwing upsert leaves the in-memory cache untouched
// and a restart cannot silently revert to a value the DB never stored. init()
// must also log corrupt rows rather than swallow them. Driven in a child
// process so the pino logger writes to a clean stderr we can assert on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

test('set(): a throwing upsert does not mutate the cache (HLB-342)', async () => {
  const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');

let upsertCalls = 0;
const stmts = {
  getAllSettings: { all: () => [{ key: 'agent_routing', value: JSON.stringify({ a: { route: 'ollama-local', model: 'llama3.1:8b' } }) }] },
  upsertSetting: { run: () => { upsertCalls++; throw new Error('disk full'); } },
};
appConfig.init(stmts);

// Sanity: the seeded value loaded.
assert.deepEqual(appConfig.get('agent_routing'), { a: { route: 'ollama-local', model: 'llama3.1:8b' } });

let threw = false;
try { appConfig.set('agent_routing', { b: { route: 'openai-api', model: 'gpt-4o' } }); }
catch (e) { threw = true; }

assert.equal(threw, true, 'set() surfaces the DB error');
assert.equal(upsertCalls, 1, 'the upsert was attempted');
// The cache must still hold the previous value — the failed write did not land.
assert.deepEqual(appConfig.get('agent_routing'), { a: { route: 'ollama-local', model: 'llama3.1:8b' } }, 'cache unchanged after a failed upsert');

console.log('writethrough assertions passed');
`;
  const { code, stdout, stderr } = await runNodeScript(SCRIPT);
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /writethrough assertions passed/);
});

test('init(): a corrupt row is logged and skipped, good rows still load (HLB-342)', async () => {
  const SCRIPT = `
const assert = require('assert');
const appConfig = require('./lib/app-config');

const stmts = {
  getAllSettings: { all: () => [
    { key: 'agent_routing', value: '{not valid json' },
    { key: 'pricing', value: JSON.stringify({ 'm': { input: 1, output: 2 } }) },
  ] },
  upsertSetting: { run: () => {} },
};
appConfig.init(stmts);

// Corrupt row skipped (absent), good row loaded.
assert.equal(appConfig.get('agent_routing', 'MISSING'), 'MISSING', 'corrupt row not cached');
assert.deepEqual(appConfig.get('pricing'), { 'm': { input: 1, output: 2 } }, 'good row loaded');

console.log('init-corrupt assertions passed');
`;
  const { code, stdout, stderr } = await runNodeScript(SCRIPT);
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /init-corrupt assertions passed/);
  // The skipped corrupt row must be logged (pino writes JSON to stderr).
  assert.match(stderr, /agent_routing/, 'corrupt row key appears in a log line');
});
