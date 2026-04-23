/**
 * Unit tests for lib/search-providers/smart.js.
 *
 * Covers Session 3 §6.1 gates:
 *   - SearXNG-only path (DDG empty)
 *   - DDG-only path (SearXNG empty)
 *   - Parallel merge + dedup by normalized URL
 *   - URL normalization (case, trailing slash, utm_, fragment)
 *   - Snippet trim with ' […]' indicator
 *   - SearXNG throws → DDG results still land; meta.error surfaces the failure
 *   - Both throw → results [] + meta.error
 *   - AbortController timeout
 *
 * Follows the runNodeScript subprocess convention from tests/_helpers.mjs —
 * tests do not import lib/* directly.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'search-providers', 'smart.js');

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

// Fixture generators inlined into each test body keep the spawned script
// self-contained — less boilerplate than threading JSON through argv.
describe('smart provider — engines', () => {
  test('SearXNG-only: returns SearXNG items with origins=["searxng"], no DDG hits', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async (url) => ({
          ok: true,
          json: async () => ({
            results: [
              { title: 'T1', url: 'https://a.example/one', content: 'snip1', engine: 'startpage' },
              { title: 'T2', url: 'https://a.example/two', content: 'snip2', engine: 'wikipedia' },
            ],
          }),
        });
        const ddgStub = { search: async () => ({ results: [] }), SafeSearchType: { OFF: -2 } };
        const p = S.createSmartProvider({ searxngUrl: 'http://x', fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('docker');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.meta.provider, 'smart');
    assert.equal(parsed.r.meta.error, undefined);
    assert.equal(parsed.r.results.length, 2);
    assert.deepEqual(parsed.r.results[0].origins, ['searxng']);
    assert.equal(parsed.r.results[0].title, 'T1');
    assert.equal(parsed.r.results[0].url, 'https://a.example/one');
  });

  test('DDG-only: SearXNG returns empty, DDG items land with origins=["ddg"]', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => ({ ok: true, json: async () => ({ results: [] }) });
        const ddgStub = {
          search: async () => ({
            results: [
              { title: '<b>DuckTitle</b>', url: 'https://d.example/one', description: 'ddg <i>snip</i>' },
            ],
          }),
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.results.length, 1);
    assert.deepEqual(parsed.r.results[0].origins, ['ddg']);
    assert.equal(parsed.r.results[0].title, 'DuckTitle', 'strips HTML tags');
    assert.equal(parsed.r.results[0].snippet, 'ddg snip', 'strips HTML from snippet');
  });

  test('parallel merge + dedup: same URL hit by both engines → origins=["searxng","ddg"]', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            results: [
              { title: 'Shared', url: 'https://ex.com/page', content: 'from searxng', engine: 'startpage' },
              { title: 'Unique-SX', url: 'https://ex.com/only-sx', content: '', engine: 'bing' },
            ],
          }),
        });
        const ddgStub = {
          search: async () => ({
            results: [
              { title: 'Shared-DDG', url: 'https://ex.com/page', description: 'from ddg' },
              { title: 'Unique-DDG', url: 'https://ex.com/only-ddg', description: '' },
            ],
          }),
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.results.length, 3, 'shared URL collapses');
    const shared = parsed.r.results.find(x => x.url === 'https://ex.com/page');
    assert.deepEqual(shared.origins, ['searxng', 'ddg'], 'both engines credited');
    assert.equal(shared.title, 'Shared', 'first-seen title wins (SearXNG)');
  });
});

describe('smart provider — URL normalization dedup', () => {
  test('case, trailing slash, utm_*, fragment variants dedup to one', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            results: [
              { title: 'A', url: 'https://Example.com/foo/?utm_source=x#bar', content: '', engine: 'startpage' },
            ],
          }),
        });
        const ddgStub = {
          search: async () => ({
            results: [
              { title: 'B', url: 'https://example.com/foo', description: '' },
            ],
          }),
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.results.length, 1, 'normalized-equivalent URLs dedup');
    assert.deepEqual(parsed.r.results[0].origins, ['searxng', 'ddg']);
  });
});

describe('smart provider — snippet trim', () => {
  test('>500 char snippet is trimmed and appended with " […]"', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const long = 'x'.repeat(800);
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            results: [{ title: 'T', url: 'https://x/1', content: long, engine: 'startpage' }],
          }),
        });
        const ddgStub = { search: async () => ({ results: [] }), SafeSearchType: { OFF: -2 } };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, snip: r.results[0].snippet, len: r.results[0].snippet.length }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.snip.endsWith(' […]'), true, 'trim indicator appended');
    assert.equal(parsed.len, 504, '500 + " […]" = 504 chars');
  });

  test('≤500 char snippet is passed through untouched', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => ({
          ok: true,
          json: async () => ({
            results: [{ title: 'T', url: 'https://x/1', content: 'short snippet', engine: 'startpage' }],
          }),
        });
        const ddgStub = { search: async () => ({ results: [] }), SafeSearchType: { OFF: -2 } };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, snip: r.results[0].snippet }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.snip, 'short snippet');
  });
});

describe('smart provider — fault tolerance', () => {
  test('SearXNG throws: DDG results still returned; meta.error surfaces the failure', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => { throw new Error('econnrefused'); };
        const ddgStub = {
          search: async () => ({
            results: [{ title: 'DDG1', url: 'https://d/1', description: 's' }],
          }),
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.r.results.length, 1);
    assert.deepEqual(parsed.r.results[0].origins, ['ddg']);
    assert.ok(parsed.r.meta.error && /searxng/.test(parsed.r.meta.error), 'meta.error names the failing engine');
  });

  test('both engines throw: results=[] and meta.error populated', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        const mockFetch = async () => { throw new Error('sx-down'); };
        const ddgStub = {
          search: async () => { throw new Error('ratelimit'); },
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ fetch: mockFetch, ddgImpl: ddgStub });
        const r = await p.search('q');
        process.stdout.write(JSON.stringify({ ok: true, r }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.deepEqual(parsed.r.results, []);
    assert.ok(parsed.r.meta.error, 'meta.error set');
    assert.match(parsed.r.meta.error, /searxng/);
    assert.match(parsed.r.meta.error, /ddg/);
  });

  test('AbortController fires at timeoutMs; no hung promises', async () => {
    const { parsed, stdout, stderr } = await runWithLib(`
        // Two "never resolves" engines — only the AbortController in the
        // provider can unblock them. If the timeout logic is broken, the
        // subprocess hits the 15s runNodeScript timeout and we catch it here.
        const mockFetch = async (url, opts) => {
          return new Promise((resolve, reject) => {
            if (opts && opts.signal) {
              opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
            }
          });
        };
        const ddgStub = {
          search: async () => new Promise(() => {}),   // never resolves
          SafeSearchType: { OFF: -2 },
        };
        const p = S.createSmartProvider({ timeoutMs: 150, fetch: mockFetch, ddgImpl: ddgStub });
        const t0 = Date.now();
        const r = await p.search('q');
        const elapsed = Date.now() - t0;
        process.stdout.write(JSON.stringify({ ok: true, elapsed, err: r.meta.error, len: r.results.length }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.ok(parsed.elapsed < 1500, `timeout did not trip; elapsed=${parsed.elapsed}ms`);
    assert.equal(parsed.len, 0);
    assert.ok(parsed.err, 'meta.error set on timeout');
  });
});
