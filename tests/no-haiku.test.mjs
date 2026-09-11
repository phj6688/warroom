// Operator ruling: War Room never runs a Claude Haiku model.
//
// A Haiku id can enter at six places, and each one is pinned here: the code
// defaults, the model env vars read at boot, a stored agent_routing row, an
// explicit caller model, the routing write validation, and the single-pair
// probe. The shipped config, code and docs are scanned too, so a new default
// or doc example that names Haiku fails CI instead of reaching a deployment.
// lib/llm.js reads env at module load, so each resolution runs in a child
// process whose env this file controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const run = async (script, env) => {
  const { code, stdout, stderr } = await runNodeScript(script, { env });
  assert.equal(code, 0, `child failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
};

const NO_LLM_ENV = { ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '' };

test('no code default resolves any agent or support call to Haiku', async () => {
  await run(`
const assert = require('assert');
const appConfig = require('./lib/app-config');
appConfig.init({ getAllSettings: { all: () => [] } });
const llm = require('./lib/llm');
const { AGENTS } = require('./lib/agents');
const { SUPPORT_CALLS } = require('./lib/preflight');
const haiku = (m) => /haiku/i.test(String(m));

assert.ok(!haiku(llm.DEFAULT_MODEL), 'DEFAULT_MODEL: ' + llm.DEFAULT_MODEL);
assert.ok(!haiku(llm.MODEL), 'MODEL: ' + llm.MODEL);
assert.equal(llm.QUALITY_MODEL, null, 'QUALITY_MODEL has no code default');
const ids = [...AGENTS.map(a => a.id), ...SUPPORT_CALLS.map(s => s.id), 'specialist-legal'];
assert.ok(ids.length >= 14);
for (const id of ids) {
  const r = llm.resolveRoute(id);
  assert.ok(r.model && !haiku(r.model), id + ' resolves to ' + r.model);
}
`, { ...NO_LLM_ENV, MODEL: '', QUALITY_MODEL: '' });
});

test('a Haiku id in MODEL, QUALITY_MODEL or AGENT_MODEL_<agentId> is ignored', async () => {
  await run(`
const assert = require('assert');
const llm = require('./lib/llm');
assert.equal(llm.MODEL, llm.DEFAULT_MODEL, 'a Haiku MODEL falls back to the code default');
assert.equal(llm.QUALITY_MODEL, null, 'a Haiku QUALITY_MODEL counts as unset');
assert.equal(llm.resolveModel('quality-evaluator'), llm.DEFAULT_MODEL, 'so a support agent follows the default');
assert.equal(llm.resolveModel('red-teamer'), llm.DEFAULT_MODEL, 'a Haiku per-agent override is skipped');
assert.equal(llm.resolveModel('divergent-generator'), 'gpt-5.6-sol', 'a non-Haiku per-agent override still applies');
`, {
    ...NO_LLM_ENV,
    MODEL: 'anthropic/claude-haiku-4-5',
    QUALITY_MODEL: 'claude-haiku-4-5-20251001',
    'AGENT_MODEL_red-teamer': 'claude-3-5-haiku-latest',
    'AGENT_MODEL_divergent-generator': 'gpt-5.6-sol',
  });
});

test('stored rows, explicit models, routing writes and probes never select Haiku', async () => {
  await run(`
const assert = require('assert');
const appConfig = require('./lib/app-config');
const routing = {
  // Rows written before the ruling, or edited by hand.
  'red-teamer': { model: 'claude-haiku-4-5' },
  'adversarial-twin': { model: 'claude-haiku-4-5' },
  'quality-evaluator': { route: 'ollama-local', model: 'anthropic/claude-3.5-haiku' },
  // A support call routed to an allowed model.
  'memory-analyzer': { route: 'ollama-local', model: 'qwen3:30b-a3b' },
};
appConfig.init({ getAllSettings: { all: () => [{ key: 'agent_routing', value: JSON.stringify(routing) }] } });
const llm = require('./lib/llm');
const { validateEntry, sanitizeRouting, mergeRouting, HAIKU_REFUSAL } = require('./lib/agent-routing');

assert.equal(llm.resolveModel('quality-evaluator'), 'gpt-5.6-sol', 'QUALITY_MODEL applies to support agents');
assert.equal(llm.resolveModel('red-teamer'), llm.DEFAULT_MODEL, 'and only to support agents');

const red = llm.resolveRoute('red-teamer');
assert.equal(red.model, llm.DEFAULT_MODEL, 'a stored model-only Haiku row resolves as if unset');
const qe = llm.resolveRoute('quality-evaluator');
assert.equal(qe.route, 'anthropic-api', 'a stored Haiku row with a route falls back to the default route');
assert.equal(qe.model, 'gpt-5.6-sol', 'and to the support model, not the stored Haiku id');
const ma = llm.resolveRoute('memory-analyzer');
assert.equal(ma.route, 'ollama-local', 'a stored support route applies');
assert.equal(ma.model, 'qwen3:30b-a3b');
assert.equal(llm.resolveRoute('process-architect', 'claude-haiku-4-5').model, llm.DEFAULT_MODEL, 'an explicit Haiku model is skipped');

const ROUTES = appConfig.ROUTES;
assert.equal(validateEntry('red-teamer', { model: 'Claude-Haiku-4-5' }, ROUTES).error, 'agent red-teamer: ' + HAIKU_REFUSAL);
assert.deepEqual(validateEntry('red-teamer', { model: 'gpt-5.6-sol' }, ROUTES), { entry: { model: 'gpt-5.6-sol' } });
assert.match(sanitizeRouting({ 'red-teamer': { route: 'openrouter', model: 'anthropic/claude-3.5-haiku' } }, new Set(['red-teamer']), ROUTES).error, /Claude Haiku/);
assert.match(mergeRouting({}, { 'quality-evaluator': { model: 'claude-haiku-4-5' } }, new Set(['quality-evaluator']), ROUTES).error, /Claude Haiku/);

(async () => {
  // The default route here is the Anthropic API with a fake key, so a probe
  // that got past the guard would fail with a provider error, not the refusal.
  const probe = await llm.testConnection({ model: 'claude-haiku-4-5' });
  assert.equal(probe.ok, false);
  assert.equal(probe.error, HAIKU_REFUSAL);

  // The dry run fails every stored Haiku row, with or without a route, and
  // names the skipped model as the cause, not a missing credential. A
  // model-only row keeps its route, so fellBack alone would call it healthy.
  // The probe itself is mocked.
  const { createPreflight } = require('./lib/preflight');
  const preflight = createPreflight({
    AGENTS: [], PHASES: [], specialist: null, appConfig, log: null, getSearchConfigForAgent: null,
    resolveRoute: llm.resolveRoute,
    testConnection: async () => ({ ok: true, latencyMs: 1 }),
  });
  const report = await preflight.run();
  const qeRow = report.support.find(s => s.id === 'quality-evaluator');
  assert.equal(qeRow.ok, false, 'a stored Haiku row that falls back is a failure');
  assert.match(qeRow.error, /anthropic\\/claude-3\\.5-haiku is skipped/);
  assert.doesNotMatch(qeRow.error, /no credentials/);
  const twinRow = report.support.find(s => s.id === 'adversarial-twin');
  assert.equal(twinRow.ok, false, 'a stored model-only Haiku row is a failure too');
  assert.match(twinRow.error, /claude-haiku-4-5 is skipped/);
  assert.equal(report.support.find(s => s.id === 'memory-analyzer').ok, true);
  assert.equal(report.ok, false);
})().catch((err) => { console.error(err); process.exit(1); });
`, { ...NO_LLM_ENV, MODEL: '', QUALITY_MODEL: 'gpt-5.6-sol' });
});

// Scanned: everything that ships and could set or suggest a model. Left out on
// purpose: CHANGELOG.md records what production ran before the ruling;
// lib/cost.js keeps the Haiku price so Haiku tokens that old sessions recorded
// are not re-priced at the fallback rate; lib/tokens.js keeps its Haiku rows,
// which only size a context budget and select nothing; tests/ feed Haiku ids in
// to prove they are refused; public/vendor/ is third-party fonts and scripts.
const HAIKU_ID = /claude-[a-z0-9.-]*haiku[a-z0-9.-]*/i;
const ROOT_FILES = ['.env.example', 'README.md', 'CONTRIBUTING.md', 'CONTEXT.md', 'Dockerfile', 'docker-compose.yml', 'server.js', 'db.js', 'index.html', 'package.json'];
const DIRS = ['lib', 'mcp', 'docker', 'docs', 'prompts', 'public', 'scripts', 'migrations'];
const SKIP = new Set(['lib/cost.js', 'lib/tokens.js', 'public/vendor']);
const TEXT = /\.(js|mjs|cjs|md|html|css|sh|sql|ya?ml|json)$/;

function shippedFiles() {
  const out = ROOT_FILES.slice();
  const walk = (rel) => {
    if (SKIP.has(rel)) return;
    const abs = path.join(REPO_ROOT, rel);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) walk(path.posix.join(rel, name));
    } else if (TEXT.test(rel)) {
      out.push(rel);
    }
  };
  for (const dir of DIRS) walk(dir);
  return out;
}

test('no shipped config, code or doc names a Claude Haiku model id', () => {
  const files = shippedFiles();
  assert.ok(files.includes('lib/llm.js') && files.includes('public/index.html'), 'the scan reaches the code and the UI');
  const hits = [];
  for (const file of files) {
    readFileSync(path.join(REPO_ROOT, file), 'utf-8').split('\n').forEach((line, i) => {
      const m = line.match(HAIKU_ID);
      if (m) hits.push(`${file}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('no model example in .env.example names Haiku, even as a bare alias', () => {
  const lines = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf-8').split('\n');
  const examples = lines.filter(l => /^\s*#?\s*[A-Z_]*MODEL[A-Za-z0-9_<>-]*=/.test(l));
  assert.ok(examples.some(l => /QUALITY_MODEL=/.test(l)), 'the support model example is still there');
  for (const l of examples) assert.doesNotMatch(l, /haiku/i, l);
});
