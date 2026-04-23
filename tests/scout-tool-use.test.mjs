/**
 * Scout tool_use integration — Session 4 §6.4.
 *
 * We can't spin up the full server (pre-existing migration bug blocks
 * spawnServer). Instead, verify:
 *
 *   1. lib/agents.js picks the research-scout-tool variant when
 *      SCOUT_USE_TOOL=true, and the legacy prompt otherwise.
 *   2. When the tool-loop is wired to the search dispatcher, the
 *      web_search handler flows through search → formatToolResult and
 *      the legacy prose-marker helpers (extractQueriesFromText) are NOT
 *      exercised.
 *   3. Final scout message is the text synthesis from the loop's final
 *      LLM call — i.e. the handler drives the scout, not a second
 *      prose-append call.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const AGENTS = path.join(REPO_ROOT, 'lib', 'agents.js');
const LOOP = path.join(REPO_ROOT, 'lib', 'agents', 'tool-loop.js');
const WEB = path.join(REPO_ROOT, 'lib', 'tools', 'web-search.js');
const SEARCH = path.join(REPO_ROOT, 'lib', 'search.js');

async function runScript(body, env = {}) {
  const script = `
    'use strict';
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000, env });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('scout prompt selection', () => {
  test('SCOUT_USE_TOOL unset → research-scout.md is loaded (legacy)', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const scout = AGENTS.find(a => a.id === 'research-scout');
        process.stdout.write(JSON.stringify({
          ok: true,
          hasSearchMarker: scout.systemPrompt.includes('SEARCH:'),
          hasToolInstruction: scout.systemPrompt.includes('web_search'),
        }));
    `, { SCOUT_USE_TOOL: '' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.hasSearchMarker, true, 'legacy prompt uses SEARCH: markers');
    assert.equal(parsed.hasToolInstruction, false, 'legacy prompt does NOT mention web_search tool');
  });

  test('SCOUT_USE_TOOL=true → research-scout-tool.md is loaded', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const { AGENTS } = require(${JSON.stringify(AGENTS)});
        const scout = AGENTS.find(a => a.id === 'research-scout');
        process.stdout.write(JSON.stringify({
          ok: true,
          hasSearchMarker: scout.systemPrompt.includes('SEARCH:'),
          hasToolInstruction: scout.systemPrompt.includes('web_search'),
        }));
    `, { SCOUT_USE_TOOL: 'true' });
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.hasSearchMarker, false, 'tool prompt does NOT use SEARCH: markers');
    assert.equal(parsed.hasToolInstruction, true, 'tool prompt mentions the web_search tool');
  });
});

describe('scout tool_use integration — handler flow', () => {
  test('web_search handler drives dispatcher.search and formatToolResult; legacy extract is not used', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const { runWithTools } = require(${JSON.stringify(LOOP)});
        const { WEB_SEARCH_TOOL, formatToolResult } = require(${JSON.stringify(WEB)});
        const { createSearchProvider } = require(${JSON.stringify(SEARCH)});

        // Mock the Tavily fetch — dispatcher in default 'tavily' mode hits Tavily.
        const tavilyResponse = {
          ok: true,
          json: async () => ({
            answer: 'mocked summary',
            results: [
              { title: 'T1', url: 'https://a/1', content: 'snip1', score: 0.9 },
              { title: 'T2', url: 'https://a/2', content: 'snip2', score: 0.8 },
            ],
          }),
        };
        const fetchFn = async () => tavilyResponse;
        const ddgImpl = { search: async () => ({ results: [] }), SafeSearchType: { OFF: -2 } };

        const dispatcher = createSearchProvider({ provider: 'tavily', tavilyApiKey: 'k', fetch: fetchFn, ddgImpl });

        // Track whether legacy helpers are called.
        let legacyExtractCalled = false;
        const origExtract = dispatcher.extractQueriesFromText.bind(dispatcher);
        dispatcher.extractQueriesFromText = (text) => { legacyExtractCalled = true; return origExtract(text); };

        const searchCache = new Map();
        const sessionId = 'S';
        const agentId = 'research-scout';
        const webSearchHandler = async ({ queries }) => {
          const results = await dispatcher.search(queries, searchCache, { sessionId, agentId });
          return formatToolResult(results);
        };

        // Mock LLM: round 1 emits a tool_use, round 2 emits synthesis.
        let llmCalls = 0;
        const llmCall = async (req) => {
          llmCalls++;
          if (llmCalls === 1) {
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 'tu_1', name: 'web_search', input: { queries: ['fastify rate limits'] } }],
            };
          }
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'SYNTHESIS_OUTPUT' }] };
        };

        const out = await runWithTools({
          llmCall, model: 'm', system: 'scout prompt',
          messages: [{ role: 'user', content: 'what are fastify rate limits?' }],
          tools: [WEB_SEARCH_TOOL],
          toolHandlers: { web_search: webSearchHandler },
          maxRounds: 3,
        });
        const finalText = out.finalMessage.content.filter(b => b.type === 'text').map(b => b.text).join('');

        // Assert the tool_result the LLM saw on round 2 matches formatToolResult's output.
        // workingMessages[2] is the user message carrying the tool_result.
        const toolResultMsg = out.workingMessages[2];
        const toolResultContent = toolResultMsg.content[0].content;

        process.stdout.write(JSON.stringify({
          ok: true,
          llmCalls,
          finalText,
          legacyExtractCalled,
          handlerInvocations: out.toolInvocations.length,
          toolResultContentHead: toolResultContent.slice(0, 80),
          toolResultHasBlock: toolResultContent.includes('=== SEARCH RESULTS ==='),
          toolResultCitesT1: toolResultContent.includes('T1'),
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.llmCalls, 2);
    assert.equal(parsed.handlerInvocations, 1);
    assert.equal(parsed.finalText, 'SYNTHESIS_OUTPUT', 'final scout message comes from the loops last LLM call');
    assert.equal(parsed.legacyExtractCalled, false, 'legacy extractQueriesFromText is NOT exercised in tool_use path');
    assert.equal(parsed.toolResultHasBlock, true, 'tool_result carries the =%%%% SEARCH RESULTS %%%% block'.replace(/%%%%/g, '==='));
    assert.equal(parsed.toolResultCitesT1, true, 'tool_result includes the mocked Tavily source');
  });
});
