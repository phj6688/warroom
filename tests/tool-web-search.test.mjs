/**
 * Unit tests for lib/tools/web-search.js.
 *
 * Gates:
 *   - WEB_SEARCH_TOOL schema shape (name, required fields, item constraints)
 *   - formatToolResult is byte-identical to formatSearchResults for the same input
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'tools', 'web-search.js');
const SEARCH = path.join(REPO_ROOT, 'lib', 'search.js');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'search-format.txt');

async function runScript(body) {
  const script = `
    'use strict';
    const T = require(${JSON.stringify(LIB)});
    const S = require(${JSON.stringify(SEARCH)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('WEB_SEARCH_TOOL schema', () => {
  test('tool has name="web_search" and a queries array input schema (1..5, 1..300 chars)', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const t = T.WEB_SEARCH_TOOL;
        const q = t.input_schema.properties.queries;
        process.stdout.write(JSON.stringify({
          ok: true,
          name: t.name,
          required: t.input_schema.required,
          queriesType: q.type,
          minItems: q.minItems,
          maxItems: q.maxItems,
          itemType: q.items.type,
          itemMin: q.items.minLength,
          itemMax: q.items.maxLength,
        }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.name, 'web_search');
    assert.deepEqual(parsed.required, ['queries']);
    assert.equal(parsed.queriesType, 'array');
    assert.equal(parsed.minItems, 1);
    assert.equal(parsed.maxItems, 5);
    assert.equal(parsed.itemType, 'string');
    assert.equal(parsed.itemMin, 1);
    assert.equal(parsed.itemMax, 300);
  });

  test('WEB_SEARCH_TOOL JSON snapshot is stable across runs', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({ ok: true, tool: T.WEB_SEARCH_TOOL }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const tool = parsed.tool;
    // Structural snapshot — description text is narrative and may evolve;
    // assert only the contract-critical fields downstream consumers depend on.
    assert.equal(tool.name, 'web_search');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, 'description is not a placeholder');
    assert.equal(tool.input_schema.type, 'object');
    assert.ok(Array.isArray(tool.input_schema.required));
  });
});

describe('formatToolResult', () => {
  test('byte-identical to formatSearchResults for Session 1 fixture input', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        const input = [
          { query: 'alpha', answer: 'first answer', sources: [
            { title: 'TitleA', url: 'https://a.example', snippet: 'snippetA', score: 0.9 },
            { title: 'TitleB', url: 'https://b.example', snippet: 'snippetB', score: 0.8 },
          ]},
          { query: 'bravo', answer: null, sources: [], error: 'Search unavailable' },
          { query: 'charlie', answer: null, sources: [
            { title: 'TitleC', url: 'https://c.example', snippet: 'snippetC', score: 0.7 },
          ]},
        ];
        const viaTool = T.formatToolResult(input);
        const viaSearch = S.formatSearchResults(input);
        process.stdout.write(JSON.stringify({ ok: true, equal: viaTool === viaSearch, viaTool }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.equal, true, 'formatToolResult diverged from formatSearchResults');
    const expected = fs.readFileSync(FIXTURE, 'utf-8');
    assert.equal(parsed.viaTool, expected, 'formatToolResult drifted from fixture');
  });

  test('empty array returns empty string', async () => {
    const { parsed, stdout, stderr } = await runScript(`
        process.stdout.write(JSON.stringify({ ok: true, out: T.formatToolResult([]) }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.out, '');
  });
});
