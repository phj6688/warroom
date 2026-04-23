// Pure helpers shared by the dispatcher and both providers. No runtime state,
// no side effects, no deps — safe to require from anywhere.

'use strict';

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

// Canonicalize a URL for dedup. Lowercase host, drop fragment, strip utm_*
// params, strip trailing slash from the path (but preserve root "/"). On parse
// failure, fall back to the raw string so we still dedup exact duplicates.
function normalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
    }
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const qs = url.searchParams.toString();
    return `${url.protocol}//${url.host}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return String(u);
  }
}

module.exports = {
  normalizeQuery,
  normalizeUrl,
  extractQueriesFromText,
  formatSearchResults,
};
