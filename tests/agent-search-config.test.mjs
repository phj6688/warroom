/**
 * Unit tests for lib/agents/search-config.js.
 *
 * Gates:
 *   - Tier assignments match ROSTER.md
 *   - Flag combinations: SCOUT_USE_TOOL × AGENT_SEARCH_EXPANSION
 *   - getSearchConfigForAgent returns null for unconfigured IDs and for
 *     configured IDs whose flag is off
 *   - appendSearchFragment substitutes {{MAX_QUERIES}} / {{MAX_ROUNDS}}
 *   - makeSessionBudget default falls back to SESSION_QUERY_BUDGET env
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'agents', 'search-config.js');

async function runScript(body, env = {}) {
  const script = `
    'use strict';
    const C = require(${JSON.stringify(LIB)});
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

describe('tier assignment', () => {
  test('scout A, red-teamer/quantitative-expert B, tier-C specialists present', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const out = {
          scout: C.AGENT_SEARCH_CONFIG['research-scout'],
          red: C.AGENT_SEARCH_CONFIG['red-teamer'],
          quant: C.AGENT_SEARCH_CONFIG['quantitative-expert'],
          legal: C.AGENT_SEARCH_CONFIG['specialist-legal'],
          medical: C.AGENT_SEARCH_CONFIG['specialist-medical'],
          financial: C.AGENT_SEARCH_CONFIG['specialist-financial'],
          security: C.AGENT_SEARCH_CONFIG['specialist-security'],
          policy: C.AGENT_SEARCH_CONFIG['specialist-policy'],
          // Tier D must NOT be present in the config.
          procArch: C.AGENT_SEARCH_CONFIG['process-architect'],
          qualitative: C.AGENT_SEARCH_CONFIG['qualitative-expert'],
          synth: C.AGENT_SEARCH_CONFIG['systems-synthesizer'],
          converge: C.AGENT_SEARCH_CONFIG['convergent-evaluator'],
          diverge: C.AGENT_SEARCH_CONFIG['divergent-generator'],
          ux: C.AGENT_SEARCH_CONFIG['specialist-ux'],
          infra: C.AGENT_SEARCH_CONFIG['specialist-infra'],
        };
        process.stdout.write(JSON.stringify({ ok: true, out }));
    `, { SCOUT_USE_TOOL: 'true', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.out.scout.tier, 'A');
    assert.equal(parsed.out.scout.maxQueries, 5);
    assert.equal(parsed.out.scout.maxRounds, 3);
    assert.equal(parsed.out.red.tier, 'B');
    assert.equal(parsed.out.red.maxQueries, 3);
    assert.equal(parsed.out.red.maxRounds, 2);
    assert.equal(parsed.out.quant.tier, 'B');
    for (const c of ['legal', 'medical', 'financial', 'security', 'policy']) {
      assert.equal(parsed.out[c].tier, 'C', `${c} must be tier C`);
      assert.equal(parsed.out[c].maxQueries, 2);
      assert.equal(parsed.out[c].maxRounds, 1);
    }
    for (const d of ['procArch', 'qualitative', 'synth', 'converge', 'diverge', 'ux', 'infra']) {
      assert.equal(parsed.out[d], undefined, `${d} must NOT appear in the config`);
    }
  });
});

describe('getSearchConfigForAgent — flag combinations', () => {
  test('SCOUT_USE_TOOL=true, AGENT_SEARCH_EXPANSION=false → scout enabled, red-teamer null', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({
          ok: true,
          scout: C.getSearchConfigForAgent('research-scout'),
          red: C.getSearchConfigForAgent('red-teamer'),
          legal: C.getSearchConfigForAgent('specialist-legal'),
          procArch: C.getSearchConfigForAgent('process-architect'),
        }));
    `, { SCOUT_USE_TOOL: 'true', AGENT_SEARCH_EXPANSION: 'false' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.ok(parsed.scout, 'scout returns a config');
    assert.equal(parsed.scout.tier, 'A');
    assert.equal(parsed.red, null);
    assert.equal(parsed.legal, null);
    assert.equal(parsed.procArch, null);
  });

  test('SCOUT_USE_TOOL=true, AGENT_SEARCH_EXPANSION=true → all tiered agents enabled', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({
          ok: true,
          scout: !!C.getSearchConfigForAgent('research-scout'),
          red: !!C.getSearchConfigForAgent('red-teamer'),
          quant: !!C.getSearchConfigForAgent('quantitative-expert'),
          legal: !!C.getSearchConfigForAgent('specialist-legal'),
          procArch: C.getSearchConfigForAgent('process-architect'),
        }));
    `, { SCOUT_USE_TOOL: 'true', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.scout, true);
    assert.equal(parsed.red, true);
    assert.equal(parsed.quant, true);
    assert.equal(parsed.legal, true);
    assert.equal(parsed.procArch, null);
  });

  test('SCOUT_USE_TOOL=false, AGENT_SEARCH_EXPANSION=true → scout null, expansion enabled', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({
          ok: true,
          scout: C.getSearchConfigForAgent('research-scout'),
          red: !!C.getSearchConfigForAgent('red-teamer'),
          legal: !!C.getSearchConfigForAgent('specialist-legal'),
        }));
    `, { SCOUT_USE_TOOL: 'false', AGENT_SEARCH_EXPANSION: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.scout, null);
    assert.equal(parsed.red, true);
    assert.equal(parsed.legal, true);
  });

  test('both flags off → every configured agent returns null', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({
          ok: true,
          scout: C.getSearchConfigForAgent('research-scout'),
          red: C.getSearchConfigForAgent('red-teamer'),
          quant: C.getSearchConfigForAgent('quantitative-expert'),
          legal: C.getSearchConfigForAgent('specialist-legal'),
          medical: C.getSearchConfigForAgent('specialist-medical'),
        }));
    `, { SCOUT_USE_TOOL: 'false', AGENT_SEARCH_EXPANSION: 'false' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    for (const k of ['scout', 'red', 'quant', 'legal', 'medical']) {
      assert.equal(parsed[k], null, `${k} must be null when both flags off`);
    }
  });
});

describe('appendSearchFragment', () => {
  test('returns base unchanged when config is null / disabled', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const base = 'You are an agent.';
        const out1 = C.appendSearchFragment(base, null);
        const out2 = C.appendSearchFragment(base, { enabled: false });
        process.stdout.write(JSON.stringify({ ok: true, out1, out2 }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.out1, 'You are an agent.');
    assert.equal(parsed.out2, 'You are an agent.');
  });

  test('substitutes {{MAX_QUERIES}} and {{MAX_ROUNDS}}', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const base = 'You are an agent.';
        const out = C.appendSearchFragment(base, { enabled: true, maxQueries: 3, maxRounds: 2 });
        process.stdout.write(JSON.stringify({
          ok: true, out,
          hasMaxQ: out.includes('up to 3 queries'),
          hasMaxR: out.includes('at most 2 time'),
          noPlaceholdersLeft: !out.includes('{{'),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.hasMaxQ, true, 'maxQueries substituted');
    assert.equal(parsed.hasMaxR, true, 'maxRounds substituted');
    assert.equal(parsed.noPlaceholdersLeft, true, 'no {{ placeholders remain');
    assert.ok(parsed.out.startsWith('You are an agent.'));
  });
});

describe('makeSessionBudget', () => {
  test('default budget comes from SESSION_QUERY_BUDGET env', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const b = C.makeSessionBudget();
        process.stdout.write(JSON.stringify({ ok: true, total: b.total, remaining: b.remaining, consumed: b.consumed }));
    `, { SESSION_QUERY_BUDGET: '7' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.total, 7);
    assert.equal(parsed.remaining, 7);
    assert.equal(parsed.consumed, 0);
  });

  test('consume clamps at remaining, reports the actual amount consumed', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const b = C.makeSessionBudget(5);
        const a = b.consume(2);
        const bb = b.consume(10);  // asks more than remaining
        process.stdout.write(JSON.stringify({ ok: true, a, bb, remaining: b.remaining, consumed: b.consumed }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.a, 2);
    assert.equal(parsed.bb, 3, 'second consume clamps from 10 → 3 (remaining)');
    assert.equal(parsed.remaining, 0);
    assert.equal(parsed.consumed, 5);
  });

  test('defaults to 30 when SESSION_QUERY_BUDGET unset or invalid', async () => {
    const { parsed } = await runScript(`
        const b = C.makeSessionBudget();
        process.stdout.write(JSON.stringify({ ok: true, total: b.total }));
    `, { SESSION_QUERY_BUDGET: '' });
    assert.equal(parsed.total, 30);
  });
});
