// HLB-877 — MCP stopSession and deleteSession (and the WS delete path) must
// release a deliberation parked on an escalation wait, instead of leaving it to
// time out after DEFAULT_TIMEOUT_MS. They now call abortSessionWaits, the same
// primitive the WS stop path uses. This drives that primitive directly through
// a child script (project convention: no test imports lib/* in-process) and
// asserts a parked wait is released fast and that abort is session-scoped, so a
// session that was NOT stopped keeps waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { waitForEscalation, abortSessionWaits, pendingCount } = require('./lib/escalation');

(async () => {
  // Park two long waits (standing in for the 5-minute blocking gate).
  const LONG = 60000;
  const wA = waitForEscalation('sessA', 'esc1', { timeoutMs: LONG });
  const wB = waitForEscalation('sessB', 'esc1', { timeoutMs: LONG });
  assert.equal(pendingCount(), 2, 'both waits parked');

  let aOutcome = null, bOutcome = null;
  wA.then(() => { aOutcome = 'resolved'; }, (e) => { aOutcome = e.message; });
  wB.then(() => { bOutcome = 'resolved'; }, (e) => { bOutcome = 'rejected:' + e.message; });

  const t0 = Date.now();
  const n = abortSessionWaits('sessA', 'session stopped via MCP');
  assert.equal(n, 1, 'exactly one wait aborted for sessA');

  await new Promise(r => setTimeout(r, 100));
  const elapsed = Date.now() - t0;
  // The stopped session's wait is released fast, not after the 60s timeout.
  assert.equal(aOutcome, 'session stopped via MCP', 'sessA wait rejected with the reason');
  assert.ok(elapsed < 1000, 'aborted within 1s, not the long timeout (got ' + elapsed + 'ms)');
  // A session that was NOT stopped keeps waiting: abort is session-scoped.
  assert.equal(bOutcome, null, 'sessB wait still pending after aborting sessA');
  assert.equal(pendingCount(), 1, 'only sessB remains parked');

  abortSessionWaits('sessB', 'cleanup');
  console.log('mcp-abort-waits assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('abortSessionWaits releases a parked wait fast and is session-scoped (HLB-877)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /mcp-abort-waits assertions passed/);
});
