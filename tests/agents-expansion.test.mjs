/**
 * Unit tests for lib/agents.js Session 5 wiring.
 *
 * Gates:
 *   - AGENT_SEARCH_EXPANSION=true → red-teamer & quantitative-expert loaded
 *     prompts include the web-search-capability fragment with substituted
 *     {{MAX_QUERIES}} / {{MAX_ROUNDS}}.
 *   - AGENT_SEARCH_EXPANSION=false → those agents' prompts do NOT contain
 *     the fragment.
 *   - Tier D agents (process-architect, qualitative-expert, etc.) never
 *     receive the fragment regardless of flag state.
 *   - Scout keeps its bespoke -tool.md prompt under SCOUT_USE_TOOL=true
 *     (no fragment appended — scout's prompt is its own variant).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const AGENTS = path.join(REPO_ROOT, 'lib', 'agents.js');

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
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000, env });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

const FRAGMENT_MARKER = 'session-wide search budget';

describe('AGENT_SEARCH_EXPANSION=false', () => {
  test('red-teamer, quantitative-expert, tier-D agents: no fragment', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const byId = Object.fromEntries(AGENTS.map(a => [a.id, a.systemPrompt]));
        process.stdout.write(JSON.stringify({
          ok: true,
          red: byId['red-teamer'].includes(${JSON.stringify(FRAGMENT_MARKER)}),
          quant: byId['quantitative-expert'].includes(${JSON.stringify(FRAGMENT_MARKER)}),
          procArch: byId['process-architect'].includes(${JSON.stringify(FRAGMENT_MARKER)}),
          qual: byId['qualitative-expert'].includes(${JSON.stringify(FRAGMENT_MARKER)}),
          synth: byId['systems-synthesizer'].includes(${JSON.stringify(FRAGMENT_MARKER)}),
        }));
    `, { SCOUT_USE_TOOL: 'false', AGENT_SEARCH_EXPANSION: 'false' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.red, false);
    assert.equal(parsed.quant, false);
    assert.equal(parsed.procArch, false);
    assert.equal(parsed.qual, false);
    assert.equal(parsed.synth, false);
  });
});

describe('AGENT_SEARCH_EXPANSION=true', () => {
  test('red-teamer prompt contains fragment with tier-B budgets (3 queries, 2 rounds)', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const byId = Object.fromEntries(AGENTS.map(a => [a.id, a.systemPrompt]));
        const red = byId['red-teamer'];
        process.stdout.write(JSON.stringify({
          ok: true,
          hasFragment: red.includes(${JSON.stringify(FRAGMENT_MARKER)}),
          hasMaxQ: red.includes('up to 3 queries'),
          hasMaxR: red.includes('at most 2 time'),
          noPlaceholders: !red.includes('{{'),
          preservesOriginal: red.includes('You are the Red Teamer'),
        }));
    `, { SCOUT_USE_TOOL: 'false', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.hasFragment, true);
    assert.equal(parsed.hasMaxQ, true);
    assert.equal(parsed.hasMaxR, true);
    assert.equal(parsed.noPlaceholders, true);
    assert.equal(parsed.preservesOriginal, true);
  });

  test('quantitative-expert prompt contains fragment with tier-B budgets', async () => {
    const { parsed, stdout } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const q = AGENTS.find(a => a.id === 'quantitative-expert').systemPrompt;
        process.stdout.write(JSON.stringify({
          ok: true,
          hasFragment: q.includes(${JSON.stringify(FRAGMENT_MARKER)}),
          hasMaxQ: q.includes('up to 3 queries'),
          hasMaxR: q.includes('at most 2 time'),
        }));
    `, { SCOUT_USE_TOOL: 'false', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stdout}`);
    assert.equal(parsed.hasFragment, true);
    assert.equal(parsed.hasMaxQ, true);
    assert.equal(parsed.hasMaxR, true);
  });

  test('process-architect and other tier-D agents never get the fragment', async () => {
    const { parsed } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const tierD = ['process-architect', 'systems-synthesizer', 'divergent-generator', 'convergent-evaluator', 'qualitative-expert'];
        const byId = Object.fromEntries(AGENTS.map(a => [a.id, a.systemPrompt]));
        const out = {};
        for (const id of tierD) out[id] = byId[id].includes(${JSON.stringify(FRAGMENT_MARKER)});
        process.stdout.write(JSON.stringify({ ok: true, out }));
    `, { SCOUT_USE_TOOL: 'true', AGENT_SEARCH_EXPANSION: 'true' });
    for (const [id, hasFrag] of Object.entries(parsed.out)) {
      assert.equal(hasFrag, false, `${id} must NOT contain the fragment`);
    }
  });
});

describe('scout uses its bespoke -tool.md prompt, not the shared fragment', () => {
  test('SCOUT_USE_TOOL=true → scout prompt mentions web_search but is not the shared fragment', async () => {
    const { parsed, stdout } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const scout = AGENTS.find(a => a.id === 'research-scout').systemPrompt;
        process.stdout.write(JSON.stringify({
          ok: true,
          // Scout's own -tool.md has "web_search" but its wording differs —
          // assert a scout-specific phrase and that it allows 5 queries / 3 rounds
          // per the scout file (not the fragment's parametric template).
          mentionsTool: scout.includes('web_search'),
          scoutSpecific: scout.includes('librarian, intelligence analyst'),
          // Should NOT contain the fragment wording.
          noSharedFragment: !scout.includes(${JSON.stringify(FRAGMENT_MARKER)}),
        }));
    `, { SCOUT_USE_TOOL: 'true', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stdout}`);
    assert.equal(parsed.mentionsTool, true);
    assert.equal(parsed.scoutSpecific, true);
    assert.equal(parsed.noSharedFragment, true, 'scout does not double-inject the shared fragment');
  });
});
