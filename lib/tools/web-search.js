// Anthropic tool definition for scout's web search. Mirrors the shape of
// ESCALATE_TOOL in server.js so the two slot into the same tool array
// without translation.
//
// formatToolResult reuses formatSearchResults from lib/search.js verbatim —
// the string that lands in a tool_result block is byte-identical to the
// `=== SEARCH RESULTS ===` block the prose-marker path already produces.
// This is the regression lock: scout's synthesis quality is unchanged, we
// just swapped the transport.

'use strict';

const { formatSearchResults } = require('../search');

const WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web for current, factual information. Batch 1–5 related queries in a single call to minimize round-trips. ' +
    'Results come back as a numbered list with title, URL, and a short snippet per source; if a provider offers an answer summary it is included. ' +
    'Use this tool only for facts you do not already know and that change over time (product versions, prices, recent news, documentation URLs). ' +
    'Do not use it for stable textbook knowledge.',
  input_schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 300 },
        minItems: 1,
        maxItems: 5,
        description: 'Up to 5 related search queries. Batch to reduce round-trips.',
      },
    },
    required: ['queries'],
  },
};

// Adapter from the dispatcher's batch-output (array of {query, answer, sources, error?})
// to the string body of a tool_result. Byte-identical to the prose-marker path.
function formatToolResult(searchOutput) {
  return formatSearchResults(searchOutput);
}

module.exports = { WEB_SEARCH_TOOL, formatToolResult };
