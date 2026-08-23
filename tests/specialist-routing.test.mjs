// Specialists must be routable like any other agent.
//
// Specialists are spawned per session from agent_templates, so they never
// appear in the core AGENTS list. The routing settings built validIds from
// AGENTS alone, and sanitizeRouting drops an unknown id with `continue` rather
// than an error, so a specialist override was accepted with 200 and silently
// discarded. Every specialist therefore resolved to the deployment default
// route forever, and a cooling-down default gateway cost a session all of its
// specialists (2026-08-11: specialist-data, -ml, -infra, -security and
// -research-methods lost every turn while the configured provider sat idle).
//
// The Settings panel and both MCP transports derive their agent list from this
// one endpoint, so widening it here is what makes specialists configurable on
// all three surfaces.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './_helpers.mjs';

const TOKEN = 'specialist-routing-test-token';

describe('specialist provider routing', () => {
  test('specialists are listed, routable, and persist across all three channels', async () => {
    const server = await spawnServer({ env: { WAR_ROOM_TOKEN: TOKEN } });
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` };
      const get = async () => {
        const r = await fetch(`${server.baseUrl}/api/settings/agent-routing`, { headers });
        assert.equal(r.status, 200, 'settings readable');
        return r.json();
      };

      const cfg = await get();
      const ids = cfg.agents.map(a => a.id);

      // The template ids come from migration 008; assert on a stable one.
      assert.ok(ids.includes('specialist-legal'), 'specialist templates are listed as routable agents');
      assert.ok(ids.includes('process-architect'), 'core agents are still listed');

      const spec = cfg.agents.find(a => a.id === 'specialist-legal');
      const core = cfg.agents.find(a => a.id === 'process-architect');
      assert.equal(spec.isSpecialist, true, 'a specialist row is flagged so the UI can group it');
      assert.equal(core.isSpecialist, false, 'a core row is flagged too, not left undefined');
      assert.ok(spec.name, 'a specialist row carries a display name');

      // effective must resolve for a specialist, so the panel can show a
      // meaningful placeholder before anything is configured.
      assert.ok(cfg.effective['specialist-legal'], 'effective resolution covers specialists');

      // Every configurable route must be offered to a specialist, not just one.
      for (const route of ['openai-api', 'anthropic-api', 'openrouter']) {
        assert.ok(cfg.routes.includes(route), `${route} is offered`);
      }

      // A specialist override must persist, on each of the three channels.
      const routing = {
        'specialist-legal': { route: 'openrouter', model: 'moonshotai/kimi-k3' },
        'specialist-ml': { route: 'anthropic-api', model: 'claude-opus-5' },
        'specialist-data': { route: 'openai-api', model: 'gpt-5.6-sol' },
        'process-architect': { route: 'openrouter', model: 'openai/gpt-5.6-sol' },
      };
      const put = await fetch(`${server.baseUrl}/api/settings/agent-routing`, {
        // skipPreflight: this test is about the store, not about whether a
        // provider answers. The dry-run gate is covered in preflight.test.mjs.
        method: 'PUT', headers, body: JSON.stringify({ routing, skipPreflight: true }),
      });
      assert.equal(put.status, 200, 'a specialist override is accepted');
      const saved = (await put.json()).routing;

      assert.deepEqual(saved['specialist-legal'], routing['specialist-legal'], 'openrouter specialist persisted');
      assert.deepEqual(saved['specialist-ml'], routing['specialist-ml'], 'anthropic specialist persisted');
      assert.deepEqual(saved['specialist-data'], routing['specialist-data'], 'openai specialist persisted');
      assert.deepEqual(saved['process-architect'], routing['process-architect'], 'core agent still persisted');

      // And it survives a re-read, so it is stored rather than echoed.
      const after = await get();
      assert.deepEqual(after.routing['specialist-legal'], routing['specialist-legal'], 'specialist override survives a re-read');
      assert.equal(after.effective['specialist-legal'].model, 'moonshotai/kimi-k3', 'a routed specialist resolves to its configured model');

      // An id that is neither a core agent nor a template is still refused.
      const bogus = await fetch(`${server.baseUrl}/api/settings/agent-routing`, {
        method: 'PUT', headers,
        body: JSON.stringify({ routing: { 'specialist-not-a-real-template': { route: 'openrouter', model: 'x' } }, skipPreflight: true }),
      });
      assert.equal(bogus.status, 200, 'an unknown id is dropped, not a 400');
      assert.ok(!('specialist-not-a-real-template' in (await bogus.json()).routing), 'an unknown id is not persisted');
    } finally {
      await server.dispose();
    }
  });
});
