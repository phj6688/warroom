/**
 * HLB-148 — pausable, resettable escalation countdown.
 *
 * The blocking escalation wait used to race a single fixed 5-minute setTimeout
 * (lib/escalation.js). This bundle turns that into a per-escalation MUTABLE
 * deadline that the human can:
 *   - pause  → the countdown suspends and the wait will NOT auto-resolve
 *   - reset  → the window restarts from now
 * and adds a getDeadline() probe the server reads to send `deadlineAt` + `paused`
 * to the client.
 *
 * These tests drive lib/escalation.js directly through a child node script (the
 * project convention — no test file imports lib/* in-process; see
 * tests/escalation-event.test.mjs). They use a SHORT injectable timeout so the
 * suite runs in well under a second — never a real 5-minute wait.
 *
 * Red phase: lib/escalation.js exposes no getDeadline / pauseEscalation /
 * resetEscalation, and the timer is a fixed setTimeout that pause cannot reach,
 * so each assertion fails for a clear, specific reason.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const ESC_MODULE = path.join(REPO_ROOT, 'lib', 'escalation.js');

describe('HLB-148 — escalation timer (mutable deadline, pause, reset)', () => {
  test('getDeadline exposes a future deadlineAt and paused=false for a live wait', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      (async () => {
        const { waitForEscalation, getDeadline, resolveEscalation } = mod;
        if (typeof getDeadline !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'export', error: 'missing getDeadline' }));
          process.exitCode = 1; return;
        }
        const before = Date.now();
        const p = waitForEscalation('s', 'e', { timeoutMs: 5000 });
        const d = getDeadline('s', 'e');
        // resolve so the process can exit cleanly
        resolveEscalation('s', 'e', 'x');
        await p.catch(() => {});
        process.stdout.write(JSON.stringify({ ok: true, d, before }));
      })().catch(err => { process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message })); process.exitCode = 9; });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.ok(parsed.d, 'getDeadline must return an object for a live wait');
    assert.equal(parsed.d.paused, false, 'a fresh wait is not paused');
    assert.ok(
      parsed.d.deadlineAt >= parsed.before + 4000 && parsed.d.deadlineAt <= parsed.before + 6000,
      `deadlineAt should sit ~timeoutMs in the future; got delta ${parsed.d?.deadlineAt - parsed.before}`
    );
  });

  test('pause holds the wait past the original deadline (no auto-resolve)', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      (async () => {
        const { waitForEscalation, pauseEscalation, getDeadline } = mod;
        if (typeof pauseEscalation !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'export', error: 'missing pauseEscalation' }));
          process.exitCode = 1; return;
        }
        // Short window so the test is fast. Pause immediately, then wait well
        // PAST the original deadline and confirm the promise never settled.
        const p = waitForEscalation('s', 'e', { timeoutMs: 150 });
        const paused = pauseEscalation('s', 'e');
        let settled = 'pending';
        p.then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });

        await new Promise(r => setTimeout(r, 500)); // 3x the original window
        const d = getDeadline('s', 'e');
        process.stdout.write(JSON.stringify({ ok: true, paused, settled, dPaused: d && d.paused, stillWaiting: !!d }));
        // leave the process — it will exit once we stop holding (force exit)
        process.exit(0);
      })().catch(err => { process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message })); process.exit(9); });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(parsed.paused, true, 'pauseEscalation must report success for a live wait');
    assert.equal(parsed.settled, 'pending', 'a paused wait must NOT auto-resolve past its original deadline');
    assert.equal(parsed.dPaused, true, 'getDeadline must reflect paused=true');
    assert.equal(parsed.stillWaiting, true, 'the waiter must still be registered while paused');
  });

  test('reset restarts the window; the wait then times out from the NEW deadline', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      (async () => {
        const { waitForEscalation, resetEscalation, getDeadline } = mod;
        if (typeof resetEscalation !== 'function') {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'export', error: 'missing resetEscalation' }));
          process.exitCode = 1; return;
        }
        const start = Date.now();
        const p = waitForEscalation('s', 'e', { timeoutMs: 200 });
        // Just before the original deadline, reset. The window must restart, so
        // the eventual timeout lands ~200ms AFTER the reset, not after the first.
        await new Promise(r => setTimeout(r, 120));
        const d1 = getDeadline('s', 'e');
        const ok = resetEscalation('s', 'e');
        const d2 = getDeadline('s', 'e');
        let elapsed = null, timedOut = false;
        try { await p; } catch (e) { timedOut = true; elapsed = Date.now() - start; }
        process.stdout.write(JSON.stringify({
          ok: true, resetReturned: ok, timedOut, elapsed,
          d1: d1 && d1.deadlineAt, d2: d2 && d2.deadlineAt,
        }));
      })().catch(err => { process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message })); process.exitCode = 9; });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(parsed.resetReturned, true, 'resetEscalation must report success for a live wait');
    assert.equal(parsed.timedOut, true, 'after reset the wait must still eventually time out');
    assert.ok(parsed.d2 > parsed.d1, `reset must push the deadline later (d1=${parsed.d1} d2=${parsed.d2})`);
    // First window was 120ms-in + 200ms = ~320ms; reset pushes timeout to ~320ms
    // from start. Demand the total elapsed proves the window genuinely restarted
    // (clearly more than the original 200ms single window).
    assert.ok(parsed.elapsed >= 300, `reset must restart the window; total elapsed only ${parsed.elapsed}ms`);
  });

  test('resolveEscalation after pause still wakes the waiter immediately', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      (async () => {
        const { waitForEscalation, pauseEscalation, resolveEscalation } = mod;
        const p = waitForEscalation('s', 'e', { timeoutMs: 150 });
        pauseEscalation('s', 'e');
        setTimeout(() => resolveEscalation('s', 'e', 'answered-while-paused'), 50);
        try {
          const answer = await p;
          process.stdout.write(JSON.stringify({ ok: true, answer }));
        } catch (e) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'wait', error: e.message }));
          process.exitCode = 2;
        }
      })().catch(err => { process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message })); process.exitCode = 9; });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(parsed.answer, 'answered-while-paused', 'answering a paused escalation must resolve the wait');
  });

  test('an untouched wait still auto-resolves (rejects) at its deadline', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      (async () => {
        const { waitForEscalation } = mod;
        const start = Date.now();
        try {
          await waitForEscalation('s', 'e', { timeoutMs: 150 });
          process.stdout.write(JSON.stringify({ ok: true, timedOut: false }));
        } catch (e) {
          process.stdout.write(JSON.stringify({ ok: true, timedOut: true, elapsed: Date.now() - start }));
        }
      })().catch(err => { process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message })); process.exitCode = 9; });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 10_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(parsed.timedOut, true, 'an untouched escalation must still time out at its deadline');
    assert.ok(parsed.elapsed >= 130, `should honor the ~150ms window; timed out after ${parsed.elapsed}ms`);
  });

  test('pause/reset on an unknown escalation return false (no throw)', async () => {
    const script = `
      'use strict';
      const mod = require(${JSON.stringify(ESC_MODULE)});
      const { pauseEscalation, resetEscalation, getDeadline } = mod;
      const out = {
        pause: pauseEscalation('nope', 'nope'),
        reset: resetEscalation('nope', 'nope'),
        deadline: getDeadline('nope', 'nope'),
      };
      process.stdout.write(JSON.stringify({ ok: true, out }));
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 8_000 });
    let parsed = null; try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(parsed.out.pause, false, 'pause on unknown id is a no-op false');
    assert.equal(parsed.out.reset, false, 'reset on unknown id is a no-op false');
    assert.equal(parsed.out.deadline, null, 'getDeadline on unknown id is null');
  });
});
