/**
 * F6 — Token budget trim that doesn't corrupt prompts.
 *
 * Spec: forge/hardening/TASKSPEC.md §F6
 *
 * Acceptance:
 *   - buildContext no longer character-slices userContent.
 *   - Trim drops oldest priorMessages one by one until total tokens ≤ 80% of budget.
 *   - The trailing instructions ("Stay in character") survive every trim.
 *   - With 100 oversized prior messages: total tokens under 80% budget,
 *     instruction string still present, at least one prior message survived.
 *
 * In red phase: buildContext is a non-exported function inside server.js
 * (line 182) that calls userContent.slice(0, …) — corrupting prompts. After
 * F6, buildContext (or a `lib/context.js` extraction) must be importable.
 *
 * Strategy: spawn a child node script that requires the intended module
 * (`lib/context.js`), constructs a synthetic session with 100 large
 * messages, calls buildContext, and reports back via stdout JSON. The
 * test asserts on the parsed result.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const CONTEXT_MODULE = path.join(REPO_ROOT, 'lib', 'context.js');

describe('F6 — buildContext token-budget trimming', () => {
  test('100 oversized prior messages: total ≤ 80% budget, instructions intact, ≥1 prior survives', async () => {
    const script = `
      'use strict';
      const ctxPath = ${JSON.stringify(CONTEXT_MODULE)};
      const tokensPath = ${JSON.stringify(path.join(REPO_ROOT, 'lib', 'tokens.js'))};

      (async () => {
        let ctxMod, tokensMod;
        try { ctxMod = require(ctxPath); }
        catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message }));
          process.exitCode = 1;
          return;
        }
        try { tokensMod = require(tokensPath); }
        catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'tokens', error: err.message }));
          process.exitCode = 1;
          return;
        }
        const { buildContext } = ctxMod;
        const { countTokens, contextBudget } = tokensMod;

        // Synthesize 100 oversized prior messages (~2 KB each).
        const big = 'lorem ipsum dolor sit amet '.repeat(80);
        const session = {
          id: 'tokbudget-test',
          problem: 'How do we ensure prompts are never silently truncated?',
          files: [],
          humanMessages: [],
          escalations: [],
          agentStates: {},
          active: true,
          createdAt: Date.now(),
          messages: Array.from({ length: 100 }, (_, i) => ({
            id: 'm' + i,
            agentId: 'process-architect',
            agentName: 'Process Architect',
            content: 'msg ' + i + ': ' + big,
            phase: 'Frame',
            timestamp: Date.now() - (100 - i) * 1000,
          })),
        };

        let messages;
        try {
          messages = buildContext(session, 'process-architect', 0);
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'buildContext', error: err.message, stack: err.stack }));
          process.exitCode = 2;
          return;
        }

        const model = process.env.MODEL || 'anthropic/claude-sonnet-4-5';
        const budget = contextBudget(model);
        const totalTokens = messages.reduce((sum, m) => sum + countTokens(m.content || ''), 0);

        const joined = messages.map(m => m.content || '').join('\\n');
        let survived = 0;
        for (let i = 0; i < 100; i++) {
          if (joined.includes('msg ' + i + ':')) survived += 1;
        }

        process.stdout.write(JSON.stringify({
          ok: true,
          budget,
          totalTokens,
          utilization: totalTokens / budget,
          hasInstruction: joined.includes('Stay in character'),
          survived,
        }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 30_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );

    assert.ok(
      parsed.totalTokens <= parsed.budget * 0.8,
      `total tokens (${parsed.totalTokens}) must be ≤ 80% of budget (${parsed.budget})`
    );
    assert.equal(
      parsed.hasInstruction,
      true,
      'the trailing "Stay in character" instructions must survive trimming'
    );
    assert.ok(
      parsed.survived >= 1,
      `at least one prior message must survive; survived=${parsed.survived}`
    );
  });

  test('trim drops whole messages, never mid-string slices', async () => {
    // Sentinel approach: each prior message has BEGIN_N + body + END_N. After
    // trimming, every surviving BEGIN_N must still pair with its END_N (proof
    // that no character-level slicing happened).
    const script = `
      'use strict';
      const ctxPath = ${JSON.stringify(CONTEXT_MODULE)};

      (async () => {
        let ctxMod;
        try { ctxMod = require(ctxPath); }
        catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message }));
          process.exitCode = 1;
          return;
        }
        const { buildContext } = ctxMod;

        const big = 'X'.repeat(2000);
        const session = {
          id: 's', problem: 'p', files: [], humanMessages: [], escalations: [],
          agentStates: {}, active: true, createdAt: Date.now(),
          messages: Array.from({ length: 60 }, (_, i) => ({
            id: 'm' + i, agentId: 'process-architect', agentName: 'PA',
            content: 'BEGIN_' + i + ' ' + big + ' END_' + i,
            phase: 'Frame', timestamp: Date.now(),
          })),
        };
        const messages = buildContext(session, 'process-architect', 0);
        const joined = messages.map(m => m.content || '').join('\\n');

        const openings = [...joined.matchAll(/BEGIN_(\\d+)/g)].map(m => m[1]);
        const orphaned = openings.filter(n => !joined.includes('END_' + n));

        process.stdout.write(JSON.stringify({ ok: true, openings: openings.length, orphaned }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 30_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.deepEqual(
      parsed.orphaned,
      [],
      `trim corrupted ${parsed.orphaned?.length} messages by mid-string slicing: ${parsed.orphaned?.join(',')}`
    );
  });
});
