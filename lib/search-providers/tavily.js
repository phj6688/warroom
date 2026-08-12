// Tavily provider. Extracted from lib/search.js in Session 3 — behavior is
// byte-identical to Session 1 by design (the formatter snapshot is the
// regression lock). Do not add retry/advanced-depth knobs here; those are
// out-of-scope deferreds.

'use strict';

const TAVILY_URL = 'https://api.tavily.com/search';
// The deadline is the provider's own, not the caller's option to forget. It was
// a caller-supplied knob that server.js never set, so a search that never
// answered held the agent turn, its phase, and the deliberation open with no
// bound at all.
const DEFAULT_TIMEOUT_MS = 20_000;

function createTavilyProvider({ apiKey, maxResults = 5, logger, timeoutMs, fetch: fetchImpl } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const fetchFn = fetchImpl || globalThis.fetch;
  // A default parameter would only cover `undefined`, so 0, null, or the NaN a
  // `Number(process.env.UNSET)` produces (all of which used to mean "no
  // deadline") would become "abort immediately" instead.
  const deadlineMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  async function callTavily(query) {
    if (!apiKey) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deadlineMs);
    try {
      const res = await fetchFn(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: true }),
        signal: ctrl.signal,
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
      clearTimeout(timer);
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
