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
import { spawnServer } from './_helpers.mjs';

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
