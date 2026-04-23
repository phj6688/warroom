/**
 * Unit tests for lib/search.js (Session 1 — parallelize + dedup + extract).
 *
 * Acceptance (from SESSION-PROMPTS §Session 1):
 *   - extractQueriesFromText: cap 5, trim, no-match → []
 *   - Dedup: concurrent identical queries → single upstream call
 *   - Dedup: distinct queries → one call per query
 *   - Parallelism: 5 × 200ms mocked latency completes in < 500ms
 *   - Partial failure: one failed query does not reject the batch
 *   - Ordering: result order matches input order regardless of resolution order
 *   - Snapshot: formatSearchResults is byte-identical to committed fixture
 *
 * Per repo convention (see tests/_helpers.mjs and tests/jobs.test.mjs),
 * lib/* is not imported by .test.mjs files directly. Each test spawns an
 * inline node script that requires lib/search.js and reports via stdout JSON.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'search.js');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'search-format.txt');

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

describe('lib/search — extractQueriesFromText', () => {
  test('caps at 5, trims whitespace, bracket form accepted, no-match → []', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const text = \`intro text
SEARCH:   spaced query
SEARCH: [bracketed query]
SEARCH: third
SEARCH: fourth
SEARCH: fifth
SEARCH: sixth should be dropped
\`;
        const a = S.extractQueriesFromText(text);
        const b = S.extractQueriesFromText('no markers here');
        const c = S.extractQueriesFromText('');
        const d = S.extractQueriesFromText(null);
        process.stdout.write(JSON.stringify({ ok: true, a, b, c, d }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.a, [
      'spaced query',
      'bracketed query',
      'third',
      'fourth',
      'fifth',
    ]);
    assert.deepEqual(parsed.b, []);
    assert.deepEqual(parsed.c, []);
    assert.deepEqual(parsed.d, []);
  });
});

describe('lib/search — session dedup cache', () => {
  test('two concurrent calls with same normalized query → one upstream fetch', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        let count = 0;
        const mockFetch = async () => {
          count++;
          await new Promise(r => setTimeout(r, 50));
          return { ok: true, json: async () => ({ answer: 'ans', results: [{ title: 't', url: 'u', content: 'c', score: 1 }] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const cache = new Map();
        const [r1, r2] = await Promise.all([
          p.search(['Same Query'], cache, { sessionId: 's1', agentId: 'a1' }),
          p.search(['same   query'], cache, { sessionId: 's1', agentId: 'a2' }),
        ]);
        process.stdout.write(JSON.stringify({ ok: true, count, r1q: r1[0].query, r2q: r2[0].query }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.count, 1, 'deduped concurrent identical queries');
    assert.equal(parsed.r1q, 'Same Query', 'first caller sees its original query text');
    assert.equal(parsed.r2q, 'same   query', 'second caller sees its original query text');
  });

  test('distinct queries → one fetch per query', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        let count = 0;
        const mockFetch = async () => {
          count++;
          return { ok: true, json: async () => ({ answer: 'a', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const cache = new Map();
        await p.search(['one', 'two', 'three'], cache, { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({ ok: true, count }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.count, 3);
  });

  test('rejected upstream call is evicted from cache (next caller retries)', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        let count = 0;
        const mockFetch = async () => {
          count++;
          if (count === 1) throw new Error('network blip');
          return { ok: true, json: async () => ({ answer: 'recovered', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const cache = new Map();
        const first = await p.search(['q'], cache, { sessionId: 's', agentId: 'a' });
        // let the .catch() eviction handler run
        await new Promise(r => setImmediate(r));
        const second = await p.search(['q'], cache, { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({
          ok: true, count,
          firstErr: first[0].error || null,
          secondErr: second[0].error || null,
          secondAnswer: second[0].answer,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.count, 2, 'retry on second call');
    assert.equal(parsed.firstErr, 'Search unavailable');
    assert.equal(parsed.secondErr, null);
    assert.equal(parsed.secondAnswer, 'recovered');
  });
});

describe('lib/search — parallelism', () => {
  test('5 queries × 200ms mock latency complete in < 500ms wall time', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => {
          await new Promise(r => setTimeout(r, 200));
          return { ok: true, json: async () => ({ answer: '', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const t0 = Date.now();
        await p.search(['q1','q2','q3','q4','q5'], new Map(), { sessionId: 's', agentId: 'a' });
        const elapsed = Date.now() - t0;
        process.stdout.write(JSON.stringify({ ok: true, elapsed }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.ok(
      parsed.elapsed < 500,
      `expected < 500ms (proves parallelism), got ${parsed.elapsed}ms`
    );
  });
});

describe('lib/search — fault tolerance', () => {
  test('one failed query in a batch of 5 yields 4 successes + 1 error, batch never rejects', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async (url, opts) => {
          const body = JSON.parse(opts.body);
          if (body.query === 'bad') {
            return { ok: false, status: 500, text: async () => 'boom' };
          }
          return { ok: true, json: async () => ({ answer: 'a', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const results = await p.search(['q1','q2','bad','q4','q5'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({
          ok: true,
          errors: results.filter(r => r.error).length,
          good: results.filter(r => !r.error).length,
          queries: results.map(r => r.query),
          badResult: results.find(r => r.query === 'bad'),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.errors, 1);
    assert.equal(parsed.good, 4);
    assert.deepEqual(parsed.queries, ['q1','q2','bad','q4','q5']);
    assert.equal(parsed.badResult.error, 'Search unavailable');
  });

  test('per-query search-complete broadcast includes error field on failure', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const events = [];
        const broadcast = (sid, data) => events.push({ sid, ...data });
        const mockFetch = async (url, opts) => {
          const body = JSON.parse(opts.body);
          if (body.query === 'bad') return { ok: false, status: 503, text: async () => 'nope' };
          return { ok: true, json: async () => ({ answer: '', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch, broadcast });
        await p.search(['ok', 'bad'], new Map(), { sessionId: 'S', agentId: 'A' });
        process.stdout.write(JSON.stringify({ ok: true, events }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const evs = parsed.events;
    assert.equal(evs.length, 2);
    const okEv = evs.find(e => e.query === 'ok');
    const badEv = evs.find(e => e.query === 'bad');
    assert.equal(okEv.type, 'search-complete');
    assert.equal(okEv.error, undefined);
    assert.equal(badEv.error, 'Search unavailable');
    assert.equal(badEv.sessionId, 'S');
    assert.equal(badEv.agentId, 'A');
  });
});

describe('lib/search — result ordering', () => {
  test('Promise.all preserves input order regardless of resolution order', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const delays = { a: 300, b: 50, c: 150 };
        const mockFetch = async (url, opts) => {
          const body = JSON.parse(opts.body);
          const d = delays[body.query] || 0;
          await new Promise(r => setTimeout(r, d));
          return { ok: true, json: async () => ({ answer: body.query + ' answer', results: [] }) };
        };
        const p = S.createSearchProvider({ apiKey: 'k', fetch: mockFetch });
        const results = await p.search(['a','b','c'], new Map(), { sessionId: 's', agentId: 'a' });
        process.stdout.write(JSON.stringify({
          ok: true,
          queries: results.map(r => r.query),
          answers: results.map(r => r.answer),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.queries, ['a','b','c']);
    assert.deepEqual(parsed.answers, ['a answer','b answer','c answer']);
  });
});

describe('lib/search — formatter snapshot', () => {
  test('formatSearchResults is byte-identical to committed fixture', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const input = [
          { query: 'alpha', answer: 'first answer', sources: [
            { title: 'TitleA', url: 'https://a.example', snippet: 'snippetA', score: 0.9 },
            { title: 'TitleB', url: 'https://b.example', snippet: 'snippetB', score: 0.8 },
          ]},
          { query: 'bravo', answer: null, sources: [], error: 'Search unavailable' },
          { query: 'charlie', answer: null, sources: [
            { title: 'TitleC', url: 'https://c.example', snippet: 'snippetC', score: 0.7 },
          ]},
        ];
        const out = S.formatSearchResults(input);
        process.stdout.write(JSON.stringify({ ok: true, out }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const expected = fs.readFileSync(FIXTURE, 'utf-8');
    assert.equal(parsed.out, expected, 'formatter output drifted from fixture');
  });

  test('formatSearchResults on empty array returns empty string', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        process.stdout.write(JSON.stringify({ ok: true, out: S.formatSearchResults([]) }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.out, '');
  });
});
