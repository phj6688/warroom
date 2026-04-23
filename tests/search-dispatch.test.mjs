/**
 * Unit tests for lib/search.js's dispatcher.
 *
 * Covers Session 3 §6.2 gates:
 *   - provider='tavily' → only Tavily invoked
 *   - provider='smart'  → only smart invoked
 *   - provider='coexist' → smart first; fall back to Tavily on empty OR error;
 *     emits `search-fallback` broadcast; skips Tavily when smart has results
 *   - Cache key includes provider identity (coexist's Tavily-cache does not
 *     shadow a later smart-only request)
 *   - Session 1 regression: same signature accepts `apiKey` and calls
 *     Tavily exactly as before.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'search.js');

async function runWithLib(body) {
  const script = `
    'use strict';
    const S = require(${JSON.stringify(LIB)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

// Shared mock-builder injected into each subprocess. The same fetch both
// Tavily and SearXNG land on is discriminated by URL; the DDG stub is
// separate. Returns counters + a results-set configurable per test.
const SHARED_MOCKS = `
  function makeMocks({ tavilyResults = null, searxngResults = [], ddgResults = [], searxngThrow = false, ddgThrow = false } = {}) {
    const counts = { tavily: 0, searxng: 0, ddg: 0 };
    const fetchFn = async (url, opts) => {
      if (url && url.toString().startsWith('https://api.tavily.com')) {
        counts.tavily++;
        if (tavilyResults === null) return { ok: false, status: 500, text: async () => 'no-tavily' };
        return { ok: true, json: async () => ({ answer: 'A', results: tavilyResults.map(r => ({ title: r.title, url: r.url, content: r.content || '', score: r.score || 0.9 })) }) };
      }
      // SearXNG
      counts.searxng++;
      if (searxngThrow) throw new Error('sx-thrown');
      return { ok: true, json: async () => ({ results: searxngResults }) };
    };
    const ddgImpl = {
      SafeSearchType: { OFF: -2 },
      search: async () => {
        counts.ddg++;
        if (ddgThrow) throw new Error('ddg-thrown');
        return { results: ddgResults };
      },
    };
    return { fetchFn, ddgImpl, counts };
  }
`;

describe('dispatcher — provider routing', () => {
  test('provider="tavily" invokes Tavily only', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({ tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }] });
        const p = S.createSearchProvider({ provider: 'tavily', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, srcLen: r[0].sources.length, answer: r[0].answer }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.tavily, 1);
    assert.equal(parsed.counts.searxng, 0);
    assert.equal(parsed.counts.ddg, 0);
    assert.equal(parsed.srcLen, 1);
    assert.equal(parsed.answer, 'A', 'Tavily answer field preserved through flatten');
  });

  test('provider="smart" invokes smart only (no Tavily call)', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({
          searxngResults: [{ title: 'S', url: 'https://s/1', content: 'c', engine: 'startpage' }],
        });
        const p = S.createSearchProvider({ provider: 'smart', tavilyApiKey: 'should-not-be-used', fetch: fetchFn, ddgImpl });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, srcLen: r[0].sources.length }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.tavily, 0);
    assert.equal(parsed.counts.searxng, 1);
    assert.equal(parsed.counts.ddg, 1);
    assert.equal(parsed.srcLen, 1);
  });
});

describe('dispatcher — coexist', () => {
  test('smart returns results → Tavily never called', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({
          searxngResults: [{ title: 'S', url: 'https://s/1', content: 'c', engine: 'startpage' }],
          tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }],
        });
        const events = [];
        const p = S.createSearchProvider({
          provider: 'coexist', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl,
          broadcast: (sid, data) => events.push({ sid, ...data }),
        });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, src: r[0].sources.length, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.searxng, 1);
    assert.equal(parsed.counts.ddg, 1);
    assert.equal(parsed.counts.tavily, 0, 'Tavily NOT called when smart succeeds');
    const fallbacks = parsed.events.filter(e => e.type === 'search-fallback');
    assert.equal(fallbacks.length, 0);
  });

  test('smart empty → falls back to Tavily + emits search-fallback', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({
          searxngResults: [],
          ddgResults: [],
          tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }],
        });
        const events = [];
        const p = S.createSearchProvider({
          provider: 'coexist', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl,
          broadcast: (sid, data) => events.push({ sid, ...data }),
        });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, src: r[0].sources.length, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.searxng, 1);
    assert.equal(parsed.counts.ddg, 1);
    assert.equal(parsed.counts.tavily, 1, 'Tavily called on smart-empty');
    assert.equal(parsed.src, 1);
    const fallbacks = parsed.events.filter(e => e.type === 'search-fallback');
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].from, 'smart');
    assert.equal(fallbacks[0].to, 'tavily');
    assert.equal(fallbacks[0].reason, 'empty');
    assert.equal(fallbacks[0].query, 'q');
  });

  test('smart errors → falls back to Tavily + reason surfaces the engine failure', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({
          searxngThrow: true,
          ddgThrow: true,
          tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }],
        });
        const events = [];
        const p = S.createSearchProvider({
          provider: 'coexist', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl,
          broadcast: (sid, data) => events.push({ sid, ...data }),
        });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, src: r[0].sources.length, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.tavily, 1);
    assert.equal(parsed.src, 1);
    const fb = parsed.events.find(e => e.type === 'search-fallback');
    assert.ok(fb, 'search-fallback emitted');
    assert.match(fb.reason, /searxng|ddg/);
  });
});

describe('dispatcher — cache scoping', () => {
  test('coexist Tavily-cached entry does not shadow a later smart-only call for the same query', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({
          searxngResults: [],
          ddgResults: [],
          tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }],
        });
        // Shared cache across two dispatcher instances (same session).
        const cache = new Map();
        const coexist = S.createSearchProvider({ provider: 'coexist', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl });
        const smart = S.createSearchProvider({ provider: 'smart', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl });

        // First call: coexist with q → smart empty, fallback to Tavily (1 tavily call).
        const r1 = await coexist.search(['q'], cache, { sessionId: 's', agentId: 'a' });
        // Second call: smart only for same q → must re-call smart even though
        // a Tavily cache entry exists. Result should be empty (smart's real
        // outcome), NOT the Tavily success that fell in under coexist.
        const r2 = await smart.search(['q'], cache, { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({
          ok: true, counts,
          r1Src: r1[0].sources.length, r1FromTavily: !!r1[0].answer,
          r2Src: r2[0].sources.length, r2Err: r2[0].error,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    // r1: 1 smart (empty) + 1 tavily fallback
    // r2: smart cache hit on the empty result (smart::q cached), OR re-called?
    // Spec wants: Tavily-cached entry MUST NOT shadow smart. Smart-cached
    // empty entry may be reused (it's still "smart's result"). The counts to
    // assert: total Tavily = 1 (coexist only), total smart = 1 OR 2.
    assert.equal(parsed.counts.tavily, 1, 'Tavily called exactly once (coexist), never shadowed smart');
    assert.equal(parsed.r1Src, 1);
    assert.equal(parsed.r2Src, 0, 'smart-only call returns smart-cached empty, NOT Tavily success');
  });
});

describe('dispatcher — Session 1 back-compat', () => {
  test('default provider is "tavily" and `apiKey` alias is honored', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        ${SHARED_MOCKS}
        const { fetchFn, ddgImpl, counts } = makeMocks({ tavilyResults: [{ title: 'T', url: 'https://t/1', content: 'c' }] });
        // Old signature: no provider option, uses apiKey. Must still work.
        const p = S.createSearchProvider({ apiKey: 'k', fetch: fetchFn, ddgImpl });
        const r = await p.search(['q'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, counts, answer: r[0].answer, srcLen: r[0].sources.length }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.counts.tavily, 1);
    assert.equal(parsed.counts.searxng, 0);
    assert.equal(parsed.answer, 'A');
  });

  test('extractQueriesFromText and formatSearchResults are still re-exported on the provider', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const p = S.createSearchProvider({ apiKey: 'k' });
        const qs = p.extractQueriesFromText('SEARCH: alpha\\nSEARCH: beta');
        const out = p.formatSearchResults([]);
        process.stdout.write(JSON.stringify({ ok: true, qs, out }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.qs, ['alpha', 'beta']);
    assert.equal(parsed.out, '');
  });
});
