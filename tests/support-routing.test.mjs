// The support calls that bracket the phases must be routable like any agent.
//
// resolveRoute already reads a stored agent_routing row for any id, but the
// routing writes kept only core agents and specialists. So the fingerprint
// classifier, memory analyzer, improver, adversarial twin and quality evaluator
// could leave the deployment default only through env: QUALITY_MODEL for four
// of them, or AGENT_MODEL_<agentId>, which `infisical run` drops because every
// id carries a hyphen. The same writes refuse a Claude Haiku model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer, runNodeScript } from './_helpers.mjs';

const SUPPORT = ['fingerprint-classifier', 'memory-analyzer', 'improver', 'adversarial-twin', 'quality-evaluator'];

test('support calls are listed, routable, and refuse a Haiku model', async () => {
  const server = await spawnServer({ env: { OPENAI_API_KEY: '', MODEL: '', QUALITY_MODEL: '' } });
  try {
    const headers = { 'Content-Type': 'application/json' };
    const get = async () => (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();
    const put = (body) => fetch(`${server.baseUrl}/api/settings/agent-routing`, { method: 'PUT', headers, body: JSON.stringify(body) });

    const cfg = await get();
    for (const id of SUPPORT) {
      const row = cfg.agents.find(a => a.id === id);
      assert.ok(row, `${id} is listed as routable`);
      assert.equal(row.isSupport, true, `${id} is flagged so the panel can mark it`);
      assert.equal(row.isSpecialist, false);
      assert.ok(row.name && row.role, `${id} carries a display name and purpose`);
      assert.ok(cfg.effective[id] && cfg.effective[id].model, `${id} has an effective model`);
    }
    assert.equal(cfg.agents.find(a => a.id === 'red-teamer').isSupport, false, 'a core row is flagged too');
    assert.equal(cfg.agents.find(a => a.id === 'specialist-legal').isSupport, false, 'and a specialist row');

    // skipPreflight: no provider answers in a test env, and the store is what
    // is under test. The dry run already walks the support calls.
    const routing = {
      'quality-evaluator': { route: 'ollama-local', model: 'qwen3:30b-a3b' },
      'fingerprint-classifier': { model: 'gpt-5.6-sol' },
    };
    const ok = await put({ routing, skipPreflight: true });
    assert.equal(ok.status, 200);
    const saved = (await ok.json()).routing;
    assert.deepEqual(saved, routing, 'support overrides are stored, not dropped as unknown ids');
    const after = await get();
    assert.deepEqual(after.effective['quality-evaluator'], { route: 'ollama-local', model: 'qwen3:30b-a3b' }, 'a stored support route resolves');
    assert.equal(after.effective['fingerprint-classifier'].model, 'gpt-5.6-sol');

    const haiku = await put({ routing: { ...routing, 'memory-analyzer': { model: 'claude-haiku-4-5' } }, skipPreflight: true });
    assert.equal(haiku.status, 400, 'a Haiku model is refused on the write');
    assert.match((await haiku.json()).error, /memory-analyzer: Claude Haiku models are not allowed/);
    assert.deepEqual((await get()).routing, saved, 'the refused write stored nothing');

    const probe = await fetch(`${server.baseUrl}/api/settings/test-connection`, {
      method: 'POST', headers, body: JSON.stringify({ route: 'ollama-local', model: 'anthropic/claude-3.5-haiku' }),
    });
    assert.equal(probe.status, 200, 'a refused probe is a verdict, like any provider failure');
    const verdict = await probe.json();
    assert.equal(verdict.ok, false);
    assert.match(verdict.error, /Claude Haiku models are not allowed/);
  } finally {
    await server.dispose();
  }
});

// A quality score records the model its evaluator call ran on. Now that the
// evaluator is routable, reading the route again after the awaited scoring let
// a routing change made mid-evaluation relabel the row with a model that never
// scored it. Driven via a child script against the real db.js.
test('a quality score keeps the evaluator model it ran on when routing changes mid-call', async () => {
  const { code, stdout, stderr } = await runNodeScript(`
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-support-label-'));
process.env.WAR_ROOM_DB_PATH = path.join(dir, 't.db');
const { db, stmts } = require('./db.js');
const appConfig = require('./lib/app-config');
appConfig.init(stmts);
appConfig.set('agent_routing', { 'quality-evaluator': { model: 'evaluator-a' } });
const { resolveRoute } = require('./lib/llm');
const { createQualityManager } = require('./lib/quality.js');

const now = Date.now();
stmts.insertSession.run('s1', 'p', now, now);
stmts.updateSessionActive.run(0, now, 's1');
stmts.updateSessionOutcome.run('complete', now, now, 's1');
stmts.insertMessage.run('m1', 's1', 'systems-synthesizer', 'Synthesizer', '', '', 'RECOMMENDATIONS: ship it', 'Synthesis', now);

const ranOn = [];
// Like the real transport, the call resolves its route the moment it starts.
const callAnthropic = async (system, messages, agentId) => {
  ranOn.push(resolveRoute(agentId).model);
  appConfig.set('agent_routing', { 'quality-evaluator': { model: 'evaluator-b' } });
  return 'STRUCTURE_SCORE: 0.8';
};
const quality = createQualityManager({ db, stmts, callAnthropic, PHASES: [], onTokenUsage: () => {} });

(async () => {
  await quality.evaluateSession('s1');
  const row = db.prepare('SELECT evaluator_model FROM quality_scores WHERE session_id = ?').get('s1');
  assert.deepEqual(ranOn, ['evaluator-a']);
  assert.equal(row.evaluator_model, 'evaluator-a', 'the row names the model the evaluator ran on');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('support label assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`, { env: { ANTHROPIC_API_KEY: 'test-anthropic', OPENAI_API_KEY: '', MODEL: '', QUALITY_MODEL: '' } });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /support label assertions passed/);
});
