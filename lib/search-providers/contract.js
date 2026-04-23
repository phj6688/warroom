// Shared contract between search providers and the dispatcher in lib/search.js.
// Types-only (JSDoc) plus a couple of runtime constants. No behavior.

'use strict';

/**
 * One merged result from any provider. The formatter (`formatSearchResults`)
 * reads `title`, `url`, `snippet` and ignores the rest — extra fields (`origins`,
 * `score`) exist for observability and future routing decisions.
 *
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} snippet           ≤500 chars, trailing ' […]' if trimmed (smart only)
 * @property {string[]} origins         e.g. ["tavily"], ["searxng","ddg"], ["ddg"]
 * @property {number} [score]           provider-native relevance, optional
 */

/**
 * Single-query provider output. The dispatcher flattens this into the
 * batch-level shape `{ query, answer, sources, error? }` that the formatter
 * (and the Session 1 unit tests) consume.
 *
 * `meta.answer` is a Tavily-specific summary string; smart never sets it.
 * `meta.error` is set on any path where the provider returned nothing usable.
 *
 * @typedef {Object} ProviderResponse
 * @property {SearchResult[]} results
 * @property {{ provider: string, latencyMs: number, answer?: string, error?: string }} meta
 */

/**
 * @typedef {Object} SearchProvider
 * @property {string} name              "tavily" | "smart"
 * @property {(query: string) => Promise<ProviderResponse>} search
 */

/** @type {const} */
const PROVIDERS = Object.freeze({
  TAVILY: 'tavily',
  SMART: 'smart',
  COEXIST: 'coexist',
});

module.exports = { PROVIDERS };
