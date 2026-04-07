/**
 * F13 — Polling loops → events.
 *
 * Spec: forge/hardening/TASKSPEC.md §F13
 *
 * Acceptance:
 *   - Escalation wait loop in runDeliberation (currently `while + setTimeout 2000`)
 *     replaced with a per-session EventEmitter / Promise the WS handler resolves.
 *   - Timeout (5 min) preserved via Promise.race.
 *   - Answering an escalation wakes the deliberation in <100 ms.
 *
 * Strategy: spawn a child node script that requires the deliberation
 * helper directly (after F13 it should be importable from a `lib/escalation.js`
 * or similar), creates a synthetic pending escalation, starts the wait, then
 * answers it ~50ms later and measures the wakeup latency.
 *
 * Red phase: the wait loop is inline in server.js with a 2000 ms tick. Even
 * if extracted, the latency will be ~2000 ms instead of <100 ms — the test
 * will fail with a clear "wakeup took Xms" message.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

// Possible locations for the extracted escalation waiter.
const CANDIDATES = [
  path.join(REPO_ROOT, 'lib', 'escalation.js'),
  path.join(REPO_ROOT, 'lib', 'escalations.js'),
  path.join(REPO_ROOT, 'lib', 'deliberation.js'),
];

describe('F13 — escalation wait is event-driven', () => {
  test('answering an escalation wakes the waiter in < 100 ms', async () => {
    const script = `
      'use strict';
      const candidates = ${JSON.stringify(CANDIDATES)};

      (async () => {
        let mod = null;
        let lastErr = null;
        for (const c of candidates) {
          try { mod = require(c); break; }
          catch (e) {
            lastErr = e;
            if (e.code !== 'MODULE_NOT_FOUND') break;
          }
        }
        if (!mod) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: lastErr && lastErr.message, tried: candidates }));
          process.exitCode = 1;
          return;
        }

        const { waitForEscalation, resolveEscalation } = mod;
        if (typeof waitForEscalation !== 'function' || typeof resolveEscalation !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'export', error: 'missing waitForEscalation or resolveEscalation' }));
          process.exitCode = 1;
          return;
        }

        const sessionId = 'esc-test-session';
        const escalationId = 'esc-test-1';

        const start = process.hrtime.bigint();
        const waitPromise = waitForEscalation(sessionId, escalationId, { timeoutMs: 5000 });

        setTimeout(() => {
          resolveEscalation(sessionId, escalationId, 'the answer');
        }, 50);

        try {
          const answer = await waitPromise;
          const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
          process.stdout.write(JSON.stringify({ ok: true, latencyMs, answer }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'wait', error: err.message }));
          process.exitCode = 2;
        }
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 15_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.ok(
      parsed.latencyMs < 100,
      `escalation wakeup latency must be < 100 ms; got ${parsed.latencyMs?.toFixed(1)} ms`
    );
    assert.equal(parsed.answer, 'the answer', 'waiter must receive the resolution payload');
  });

  test('waitForEscalation honors the timeout when no answer arrives', async () => {
    const script = `
      'use strict';
      const candidates = ${JSON.stringify(CANDIDATES)};

      (async () => {
        let mod = null;
        let lastErr = null;
        for (const c of candidates) {
          try { mod = require(c); break; }
          catch (e) {
            lastErr = e;
            if (e.code !== 'MODULE_NOT_FOUND') break;
          }
        }
        if (!mod) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: lastErr && lastErr.message, tried: candidates }));
          process.exitCode = 1;
          return;
        }
        const { waitForEscalation } = mod;

        const start = Date.now();
        try {
          await waitForEscalation('s', 'e', { timeoutMs: 200 });
          process.stdout.write(JSON.stringify({ ok: true, timedOut: false, elapsed: Date.now() - start }));
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: true, timedOut: true, elapsed: Date.now() - start, error: err.message }));
        }
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.ok(
      parsed.timedOut === true || parsed.elapsed >= 180,
      'waitForEscalation must respect the configured timeout (or reject on it)'
    );
  });
});
