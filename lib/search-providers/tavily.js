// Tavily provider. Extracted from lib/search.js in Session 3 — behavior is
// byte-identical to Session 1 by design (the formatter snapshot is the
// regression lock). Do not add retry/timeout/advanced-depth knobs here; those
// are out-of-scope deferreds.

'use strict';

const TAVILY_URL = 'https://api.tavily.com/search';

function createTavilyProvider({ apiKey, maxResults = 5, logger, timeoutMs, fetch: fetchImpl } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const fetchFn = fetchImpl || globalThis.fetch;

  async function callTavily(query) {
    if (!apiKey) return null;
    const ctrl = timeoutMs ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: true }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) {
        const body = await res.text();
        log.error({ status: res.status, body }, 'tavily search error');
        return null;
      }
      return await res.json();
    } catch (err) {
      log.error({ err: err.message }, 'tavily search failed');
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function search(query) {
    const t0 = Date.now();
    const data = await callTavily(query);
    const latencyMs = Date.now() - t0;
    if (!data) {
      return { results: [], meta: { provider: 'tavily', latencyMs, error: 'Search unavailable' } };
    }
    const results = (data.results || []).map(r => ({
      title: r.title,
      url: r.url,
      // Snippet stays untouched at 500-char slice (no indicator) — the
      // formatter snapshot from Session 1 locks this byte-for-byte.
      snippet: (r.content || '').slice(0, 500),
      origins: ['tavily'],
      score: r.score,
    }));
    return {
      results,
      meta: {
        provider: 'tavily',
        latencyMs,
        answer: data.answer || null,
      },
    };
  }

  return { name: 'tavily', search };
}

module.exports = { createTavilyProvider };
