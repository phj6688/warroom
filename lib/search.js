// Tavily search provider. Extracted from server.js so the batch logic is
// testable in isolation and so future providers can slot behind the same
// factory interface.
//
// Parallelism: Promise.all — all queries fire concurrently, results are
// returned in input order regardless of resolution order.
//
// Per-session dedup: the caller supplies a Map<normalizedQuery, Promise>
// keyed by normalized query. Two concurrent callers that ask for the same
// query share one upstream request. Rejections are evicted so the next
// caller retries instead of sticking to a dead result.

'use strict';

const TAVILY_URL = 'https://api.tavily.com/search';

function normalizeQuery(q) {
  return String(q).toLowerCase().trim().replace(/\s+/g, ' ');
}

function extractQueriesFromText(text) {
  const queries = [];
  const regex = /SEARCH:\s*(.+?)(?:\n|$)/g;
  let match;
  while ((match = regex.exec(String(text || ''))) !== null) {
    const q = match[1].trim().replace(/^\[|\]$/g, '');
    if (q.length > 2) queries.push(q);
  }
  return queries.slice(0, 5);
}

function formatSearchResults(results) {
  if (!results.length) return '';
  let text = '\n\n=== SEARCH RESULTS ===\n';
  results.forEach((r, i) => {
    text += `\n--- Search ${i + 1}: "${r.query}" ---\n`;
    if (r.error) { text += `[Search unavailable]\n`; return; }
    if (r.answer) text += `Summary: ${r.answer}\n`;
    if (r.sources.length) {
      text += `Sources:\n`;
      r.sources.forEach((s, j) => { text += `  ${j + 1}. ${s.title}\n     ${s.url}\n     ${s.snippet}\n`; });
    }
  });
  text += '\n=== END SEARCH RESULTS ===\n';
  return text;
}

function createSearchProvider({ apiKey, maxResults = 5, logger, broadcast, fetch: fetchImpl } = {}) {
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const fetchFn = fetchImpl || globalThis.fetch;
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  async function tavilySearch(query) {
    if (!apiKey) return null;
    try {
      const res = await fetchFn(TAVILY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: true }),
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
    }
  }

  async function runOne(query) {
    const data = await tavilySearch(query);
    if (data) {
      return {
        query,
        answer: data.answer || null,
        sources: (data.results || []).map(r => ({
          title: r.title,
          url: r.url,
          snippet: (r.content || '').slice(0, 500),
          score: r.score,
        })),
      };
    }
    return { query, answer: null, sources: [], error: 'Search unavailable' };
  }

  async function search(queries, cache, ctx = {}) {
    const { sessionId, agentId } = ctx;
    const store = cache instanceof Map ? cache : null;

    const promises = queries.map(query => {
      const key = normalizeQuery(query);
      let p;
      if (store && store.has(key)) {
        p = store.get(key);
      } else {
        p = runOne(query);
        if (store) {
          store.set(key, p);
          // Evict on failure (error result or promise rejection) so the
          // next caller retries instead of being stuck on a dead answer.
          p.then(
            (r) => { if (r && r.error) store.delete(key); },
            () => { store.delete(key); },
          );
        }
      }
      return p.then(result => {
        // Rewrite `query` to the caller's spelling so the formatter renders
        // what the caller asked for, even on a cache hit where another
        // caller's normalization-equivalent spelling was the first one in.
        const out = result ? { ...result, query } : result;
        if (sessionId !== undefined) {
          const payload = {
            type: 'search-complete',
            agentId,
            query,
            resultCount: out.sources ? out.sources.length : 0,
            sessionId,
          };
          if (out.error) payload.error = out.error;
          emit(sessionId, payload);
        }
        return out;
      });
    });

    return Promise.all(promises);
  }

  return { search, extractQueriesFromText, formatSearchResults };
}

module.exports = {
  createSearchProvider,
  extractQueriesFromText,
  formatSearchResults,
  normalizeQuery,
};
