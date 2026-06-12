/**
 * Unit tests for lib/token-usage.js — the per-session token accumulator.
 *
 * HLB-152. A session spends tokens across agent turns, tool round-trips,
 * quality scoring, memory analysis, and embeddings. The ledger normalizes the
 * usage object each LLM/embedding call reports (Anthropic and OpenAI shapes
 * differ) and accumulates a per-session total broken down by purpose.
 *
 * Gates:
 *   - normalizeUsage handles Anthropic ({input_tokens,output_tokens,cache_*})
 *     and OpenAI ({prompt_tokens,completion_tokens,total_tokens}) shapes, and
 *     a null/garbage input returns zeros.
 *   - the ledger sums input/output/total per category across many calls.
 *   - snapshot() returns { total_tokens, token_breakdown } with the grand
 *     total equal to the sum of every category total.
 *   - embedding entries carry an `estimated` count when the provider gave no
 *     real usage.
 *   - sessions are isolated; clear() drops a session's tally.
 *
 * Follows the runNodeScript subprocess convention — no direct lib import.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const LIB = path.join(REPO_ROOT, 'lib', 'token-usage.js');

async function runScript(body) {
  const script = `
    'use strict';
    const T = require(${JSON.stringify(LIB)});
    (async () => {
      try {
${body}
      } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message, stack: err.stack }));
        process.exitCode = 1;
      }
    })();
  `;
  const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
  let parsed = null;
  try { parsed = JSON.parse(stdout); } catch {}
  return { code, stdout, stderr, parsed };
}

describe('token-usage: normalizeUsage', () => {
  test('Anthropic shape maps input/output and derives total', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const u = T.normalizeUsage({ input_tokens: 100, output_tokens: 40 });
      process.stdout.write(JSON.stringify({ ok: true, u }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.u.input_tokens, 100);
    assert.equal(parsed.u.output_tokens, 40);
    assert.equal(parsed.u.total_tokens, 140);
  });

  test('Anthropic cache tokens fold into the input side of the total', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const u = T.normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 });
      process.stdout.write(JSON.stringify({ ok: true, u }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    // input side counts the live input + both cache buckets.
    assert.equal(parsed.u.input_tokens, 240);
    assert.equal(parsed.u.output_tokens, 5);
    assert.equal(parsed.u.total_tokens, 245);
  });

  test('OpenAI shape maps prompt/completion and prefers reported total', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const u = T.normalizeUsage({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 });
      process.stdout.write(JSON.stringify({ ok: true, u }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.u.input_tokens, 80);
    assert.equal(parsed.u.output_tokens, 20);
    assert.equal(parsed.u.total_tokens, 100);
  });

  test('null / garbage usage normalizes to zeros', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const a = T.normalizeUsage(null);
      const b = T.normalizeUsage(undefined);
      const c = T.normalizeUsage({ nonsense: true });
      process.stdout.write(JSON.stringify({ ok: true, a, b, c }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    for (const k of ['a', 'b', 'c']) {
      assert.deepEqual(parsed[k], { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    }
  });
});

describe('token-usage: ledger accumulation', () => {
  test('sums agent-turn, tool-call, quality, memory and embedding across many calls; grand total matches', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const ledger = T.createTokenLedger();
      const sid = 'S1';
      // Two agent turns (Anthropic shape).
      ledger.add(sid, 'agent_turn', { input_tokens: 100, output_tokens: 50 });
      ledger.add(sid, 'agent_turn', { input_tokens: 200, output_tokens: 80 });
      // One tool round-trip total already summed by the loop (OpenAI shape).
      ledger.add(sid, 'tool_call', { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420 });
      // Quality scoring.
      ledger.add(sid, 'quality', { input_tokens: 60, output_tokens: 10 });
      // Memory analyzer turn.
      ledger.add(sid, 'memory', { input_tokens: 40, output_tokens: 8 });
      // Embedding with a real provider usage.
      ledger.add(sid, 'embedding', { input_tokens: 25, output_tokens: 0 });
      // Embedding via estimate fallback.
      ledger.add(sid, 'embedding', { input_tokens: 15, output_tokens: 0 }, { estimated: true });

      const snap = ledger.snapshot(sid);
      process.stdout.write(JSON.stringify({ ok: true, snap }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    const { snap } = parsed;
    const bd = snap.token_breakdown;

    assert.equal(bd.agent_turn.input_tokens, 300);
    assert.equal(bd.agent_turn.output_tokens, 130);
    assert.equal(bd.agent_turn.total_tokens, 430);
    assert.equal(bd.agent_turn.calls, 2);

    assert.equal(bd.tool_call.total_tokens, 420);
    assert.equal(bd.tool_call.calls, 1);

    assert.equal(bd.quality.total_tokens, 70);
    assert.equal(bd.memory.total_tokens, 48);

    // embeddings: 25 + 15 input, totals 25 + 15 = 40; estimated count tracks
    // only the fallback entry.
    assert.equal(bd.embedding.input_tokens, 40);
    assert.equal(bd.embedding.total_tokens, 40);
    assert.equal(bd.embedding.calls, 2);
    assert.equal(bd.embedding.estimated, 15);

    // Grand total is the sum of every category total.
    const sumOfCats = Object.values(bd).reduce((n, c) => n + c.total_tokens, 0);
    assert.equal(snap.total_tokens, sumOfCats);
    assert.equal(snap.total_tokens, 430 + 420 + 70 + 48 + 40);
  });

  test('sessions are isolated and clear() drops a tally', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const ledger = T.createTokenLedger();
      ledger.add('A', 'agent_turn', { input_tokens: 10, output_tokens: 5 });
      ledger.add('B', 'agent_turn', { input_tokens: 1, output_tokens: 1 });
      const a1 = ledger.snapshot('A').total_tokens;
      const b1 = ledger.snapshot('B').total_tokens;
      ledger.clear('A');
      const a2 = ledger.snapshot('A').total_tokens;
      process.stdout.write(JSON.stringify({ ok: true, a1, b1, a2 }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.a1, 15);
    assert.equal(parsed.b1, 2);
    assert.equal(parsed.a2, 0, 'cleared session reports zero');
  });

  test('snapshot of an unknown session is a zeroed shape, not a throw', async () => {
    const { parsed, stdout, stderr } = await runScript(`
      const ledger = T.createTokenLedger();
      const snap = ledger.snapshot('never-seen');
      process.stdout.write(JSON.stringify({ ok: true, snap }));
    `);
    assert.ok(parsed?.ok, `runner failed: ${stderr}\n${stdout}`);
    assert.equal(parsed.snap.total_tokens, 0);
    assert.equal(parsed.snap.token_breakdown.agent_turn.total_tokens, 0);
    assert.equal(parsed.snap.token_breakdown.embedding.calls, 0);
  });
});
