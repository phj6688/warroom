// HLB-335 — live token-tick throttle. The gate decides when onTokenUsage pushes
// a live snapshot to a session's subscribers, so it is exercised here with an
// injected clock rather than wall time (a full deliberation is the Playwright
// e2e; this pins the boundary conditions deterministically).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTickThrottle } from '../lib/token-usage.js';

test('throttle: first accrual emits, then gated until intervalMs since last emit', () => {
  const t = createTickThrottle(1500);
  assert.equal(t.shouldEmit('s1', 1000), true, 'first accrual always emits');
  assert.equal(t.shouldEmit('s1', 1999), false, 'within window: suppressed');
  assert.equal(t.shouldEmit('s1', 2499), false, 'still within window');
  assert.equal(t.shouldEmit('s1', 2500), true, 'window elapsed from last emit (1000)');
  assert.equal(t.shouldEmit('s1', 3999), false, 'new window from 2500');
  assert.equal(t.shouldEmit('s1', 4000), true, 'window elapsed again');
});

test('throttle: sessions are independent', () => {
  const t = createTickThrottle(1500);
  assert.equal(t.shouldEmit('a', 1000), true);
  assert.equal(t.shouldEmit('b', 1000), true, 'b is not gated by a');
  assert.equal(t.shouldEmit('a', 1200), false);
  assert.equal(t.shouldEmit('b', 1200), false);
});

test('throttle: reset drops the timer so the next accrual emits immediately', () => {
  const t = createTickThrottle(1500);
  assert.equal(t.shouldEmit('s', 1000), true);
  assert.equal(t.shouldEmit('s', 1100), false);
  t.reset('s');
  assert.equal(t.shouldEmit('s', 1100), true, 'after reset, treated as first accrual');
});

test('throttle: a missing session id never emits', () => {
  const t = createTickThrottle(1500);
  assert.equal(t.shouldEmit(null, 1000), false);
  assert.equal(t.shouldEmit(undefined, 5000), false);
  assert.equal(t.shouldEmit('', 5000), false);
});
