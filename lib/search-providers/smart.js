// Smart provider. JS port of smart-search-skill's search_direct (tools.py:170)
// from the Session 2 recon — minus the LangGraph evaluator, which the scout's
// second synthesis turn already subsumes.
//
// Fires SearXNG and DuckDuckGo in parallel via Promise.all, merges, and
// dedups by normalized URL. Each surviving result carries `origins` listing
// the engines that returned it.
//
// SearXNG path: plain HTTP GET to /search?format=json. No health probe —
// that would double the latency on every query; we just try and fail over
// within the same parallel call.
// DDG path: duck-duck-scrape (MIT, pinned exact). The `ddgImpl` option lets
// tests inject a fake without mocking the whole module.

'use strict';

const { normalizeUrl } = require('./shared');

const SNIPPET_MAX = 500;
const SNIPPET_SUFFIX = ' […]';

function trimSnippet(s) {
  const str = String(s || '');
  if (str.length <= SNIPPET_MAX) return str;
  return str.slice(0, SNIPPET_MAX) + SNIPPET_SUFFIX;
}

// Strip HTML tags (DDG's description field sometimes contains <b>…</b>).
// Lightweight — we don't need a full parser here.
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, '');
}

function createSmartProvider({
  searxngUrl = 'http://localhost:9090',
  maxResults = 5,
  logger,
  timeoutMs = 4000,
  categories = 'general',
  fetch: fetchImpl,
  ddgImpl,        // optional — defaults to duck-duck-scrape lazily
} = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const fetchFn = fetchImpl || globalThis.fetch;
  const baseUrl = String(searxngUrl).replace(/\/+$/, '');

  async function searxngQuery(query) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        categories,
        language: 'en',
        safesearch: '0',
      });
      const res = await fetchFn(`${baseUrl}/search?${params.toString()}`, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) {
        log.error({ status: res.status }, 'searxng non-ok');
        return { items: [], error: `searxng ${res.status}` };
      }
      const data = await res.json();
      const items = (data.results || []).map(r => ({
        title: String(r.title || ''),
        url: String(r.url || ''),
        snippet: trimSnippet(r.content),
        engine: r.engine || 'searxng',
      }));
      return { items };
    } catch (err) {
      // AbortError, network error, JSON parse error — reported, swallowed so
      // the DDG half of the parallel gather still lands. The caller keeps
      // any successful items and surfaces the error in meta.
      log.error({ err: err.message }, 'searxng search failed');
      return { items: [], error: `searxng: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  function loadDdg() {
    if (ddgImpl) return ddgImpl;
    // Lazy require so tests that inject ddgImpl don't need duck-duck-scrape
    // on the module graph.
    // eslint-disable-next-line global-require
    const mod = require('duck-duck-scrape');
    return { search: mod.search, SafeSearchType: mod.SafeSearchType };
  }

  async function ddgQuery(query) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { search: ddgSearch, SafeSearchType } = loadDdg();
      const raced = await Promise.race([
        ddgSearch(query, { safeSearch: (SafeSearchType && SafeSearchType.OFF) || -2 }),
        new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('ddg timeout')))),
      ]);
      const rawItems = (raced && raced.results) || [];
      const items = rawItems.map(r => ({
        title: stripHtml(r.title || ''),
        url: String(r.url || ''),
        snippet: trimSnippet(stripHtml(r.description || r.rawDescription || '')),
        engine: 'ddg',
      }));
      return { items };
    } catch (err) {
      // Rate-limit ("DDG detected an anomaly…"), network, or timeout —
      // swallowed so SearXNG half still lands.
      log.error({ err: err.message }, 'ddg search failed');
      return { items: [], error: `ddg: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function search(query) {
    const t0 = Date.now();
    const [searxngRes, ddgRes] = await Promise.all([
      searxngQuery(query),
      ddgQuery(query),
    ]);

    // Merge, keyed by normalized URL. First occurrence owns title/snippet;
    // any later hit on the same URL just adds to `origins`.
    const byKey = new Map();
    function ingest(items, engine) {
      for (const r of items) {
        if (!r.url) continue;
        const key = normalizeUrl(r.url);
        if (!key) continue;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.origins.includes(engine)) existing.origins.push(engine);
          continue;
        }
        byKey.set(key, {
          title: r.title,
          url: r.url,
          snippet: r.snippet,
          origins: [engine],
        });
      }
    }
    ingest(searxngRes.items, 'searxng');
    ingest(ddgRes.items, 'ddg');

    // Deterministic order: SearXNG first (insertion), then DDG. Map preserves
    // insertion order in V8. Slice to maxResults after merge.
    const results = Array.from(byKey.values()).slice(0, maxResults);
    const latencyMs = Date.now() - t0;

    const meta = { provider: 'smart', latencyMs };
    // meta.error is set iff an engine *failed* (threw / non-ok HTTP). A
    // genuinely empty result set (both engines responded 200 with no matches)
    // leaves meta.error unset — the dispatcher distinguishes "nothing found"
    // from "engines down" via this signal.
    const errors = [searxngRes.error, ddgRes.error].filter(Boolean);
    if (errors.length) meta.error = errors.join('; ');
    return { results, meta };
  }

  return { name: 'smart', search };
}

module.exports = { createSmartProvider };
