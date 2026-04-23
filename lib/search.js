// Search dispatcher. Owns the batch-and-cache orchestration that was in
// Session 1, and now routes per-query work to one of three strategies:
//
//   provider='tavily'  → Tavily only (Session 1 behavior preserved)
//   provider='smart'   → SearXNG + DDG parallel, no LLM rerank
//   provider='coexist' → smart first; if empty or errored, fall back to Tavily
//
// The output shape the formatter consumes — `{ query, answer, sources, error? }`
// — is kept flat and identical to Session 1. Providers return
// `{ results, meta }` (see lib/search-providers/contract.js); the dispatcher
// flattens here.
//
// Cache keys are scoped by the provider name so that a coexist fallback's
// Tavily result does not contaminate a later smart-only request in the same
// session (or vice versa).

'use strict';

const {
  normalizeQuery,
  normalizeUrl,
  extractQueriesFromText,
  formatSearchResults,
} = require('./search-providers/shared');
const { createTavilyProvider } = require('./search-providers/tavily');
const { createSmartProvider } = require('./search-providers/smart');
const { PROVIDERS } = require('./search-providers/contract');

function createSearchProvider(opts = {}) {
  const {
    provider = PROVIDERS.TAVILY,
    // `apiKey` is the Session 1 name; keep it as a back-compat alias.
    apiKey,
    tavilyApiKey = apiKey,
    searxngUrl,
    maxResults = 5,
    logger,
    broadcast,
    timeoutMs,
    fetch: fetchImpl,
    ddgImpl,
  } = opts;

  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const emit = typeof broadcast === 'function' ? broadcast : () => {};

  // Only instantiate the providers the caller will actually use. Keeping the
  // constructor lazy means an operator who sets SEARCH_PROVIDER=smart without
  // a Tavily key won't trip over Tavily's missing-key path.
  let tavily = null;
  let smart = null;
  function getTavily() {
    if (!tavily) tavily = createTavilyProvider({ apiKey: tavilyApiKey, maxResults, logger: log, timeoutMs, fetch: fetchImpl });
    return tavily;
  }
  function getSmart() {
    if (!smart) smart = createSmartProvider({ searxngUrl, maxResults, logger: log, timeoutMs, fetch: fetchImpl, ddgImpl });
    return smart;
  }

  // Adapter: turn a ProviderResponse into the flat, formatter-ready shape.
  function flatten(providerResp, query) {
    const meta = providerResp.meta || {};
    const out = {
      query,
      answer: meta.answer || null,
      sources: providerResp.results || [],
    };
    if (meta.error) out.error = meta.error;
    return out;
  }

  // Run one query under a given provider name, with session-scoped dedup
  // keyed by `${provider}::${normalizedQuery}`. The returned Promise resolves
  // to a flat result; rejections/error-results are evicted from the cache so
  // the next caller retries.
  function runCached(providerName, query, cache) {
    const store = cache instanceof Map ? cache : null;
    const key = `${providerName}::${normalizeQuery(query)}`;

    if (store && store.has(key)) return store.get(key);

    const inst = providerName === PROVIDERS.SMART ? getSmart() : getTavily();
    const p = inst.search(query).then(r => flatten(r, query));

    if (store) {
      store.set(key, p);
      // Evict only on *total* failure (error set + zero sources) or promise
      // rejection — partial successes (e.g. smart with SearXNG down but DDG
      // OK) stay cached to preserve dedup.
      p.then(
        (r) => {
          if (r && r.error && (!r.sources || r.sources.length === 0)) store.delete(key);
        },
        () => { store.delete(key); },
      );
    }
    return p;
  }

  // Coexist path: smart first, fall back to Tavily on empty-or-error. Both
  // halves cache under their own provider-scoped key so a follow-up request
  // in either pure mode still benefits from whatever was fetched.
  async function runCoexist(query, cache, sessionId, agentId) {
    const smartOut = await runCached(PROVIDERS.SMART, query, cache);
    const smartEmpty = !smartOut.error && (!smartOut.sources || smartOut.sources.length === 0);
    if (!smartOut.error && !smartEmpty) return smartOut;

    const reason = smartOut.error ? smartOut.error : 'empty';
    if (sessionId !== undefined) {
      emit(sessionId, {
        type: 'search-fallback',
        agentId,
        query,
        reason,
        from: PROVIDERS.SMART,
        to: PROVIDERS.TAVILY,
        sessionId,
      });
    }
    return runCached(PROVIDERS.TAVILY, query, cache);
  }

  async function search(queries, cache, ctx = {}) {
    const { sessionId, agentId } = ctx;

    const promises = queries.map(query => {
      const pending =
        provider === PROVIDERS.SMART   ? runCached(PROVIDERS.SMART, query, cache) :
        provider === PROVIDERS.COEXIST ? runCoexist(query, cache, sessionId, agentId) :
                                         runCached(PROVIDERS.TAVILY, query, cache);
      return pending.then(result => {
        // Preserve Session 1 semantic: the caller sees its own spelling in
        // the returned record, even if a different-spelling caller populated
        // the cache first.
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
  normalizeUrl,
  PROVIDERS,
};
