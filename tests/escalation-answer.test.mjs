// Answering an escalation has to do four things: persist it, update the live
// session, release the deliberation parked on it, and tell the clients. The
// MCP path did only the first two (mcp/http.js answerEscalation), so an answer
// sent over MCP left the loop parked on its 5-minute wait and the room stood
// still while the caller believed it had unblocked the room. Both transports
// now share one routine, so the paths cannot drift again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { waitForEscalation, answerEscalationById, pendingCount } = require('./lib/escalation');

function fakeDeps() {
  const persisted = [];
  const events = [];
  const session = {
    id: 'sessA',
    escalations: [{ id: 'esc1', question: 'q', answered: false, answer: null, severity: 'blocking' }],
  };
  return {
    persisted,
    events,
    session,
    deps: {
      stmts: {
        answerEscalation: { run: (answer, at, id) => persisted.push({ answer, at, id }) },
        getEscalation: { get: (id) => (id === 'esc1' ? { id: 'esc1', session_id: 'sessA' } : null) },
      },
      activeSessions: new Map([['sessA', session]]),
      broadcast: (sessionId, payload) => events.push({ sessionId, payload }),
    },
  };
}

(async () => {
  // A deliberation parked on a blocking escalation, exactly as the phase gate
  // parks it in runDeliberation.
  const f = fakeDeps();
  const parked = waitForEscalation('sessA', 'esc1', { timeoutMs: 60000 });
  let released = null;
  parked.then((a) => { released = a; }, (e) => { released = 'rejected:' + e.message; });
  assert.equal(pendingCount(), 1, 'wait parked');

  const t0 = Date.now();
  const out = answerEscalationById(f.deps, 'esc1', 'do option B');
  await new Promise(r => setTimeout(r, 50));
  const elapsed = Date.now() - t0;

  assert.equal(released, 'do option B', 'the parked deliberation must wake with the answer');
  assert.ok(elapsed < 1000, 'woken in ' + elapsed + 'ms, not after the 5-minute timeout');
  assert.equal(pendingCount(), 0, 'no waiter left behind');
  assert.equal(f.persisted.length, 1, 'the answer is persisted once');
  assert.equal(f.persisted[0].id, 'esc1');
  assert.equal(f.session.escalations[0].answered, true, 'the live session sees it answered');
  assert.equal(f.session.escalations[0].answer, 'do option B');
  assert.equal(f.events.length, 1, 'clients are told');
  assert.equal(f.events[0].payload.type, 'escalation-answered');
  assert.equal(out.sessionId, 'sessA');
  assert.equal(out.resolved, true, 'reports that it released a parked wait');

  // An escalation from a session that is no longer running still persists and
  // still reaches the clients; there is simply no waiter to release.
  const g = fakeDeps();
  g.deps.activeSessions = new Map();
  const out2 = g.deps && answerEscalationById(g.deps, 'esc1', 'late answer');
  assert.equal(g.persisted.length, 1, 'persisted for an inactive session too');
  assert.equal(out2.sessionId, 'sessA', 'session id recovered from the escalation row');
  assert.equal(out2.resolved, false, 'nothing was parked, so nothing was released');

  // An unknown id is a no-op, not a throw.
  const h = fakeDeps();
  h.deps.stmts.getEscalation = { get: () => null };
  h.deps.activeSessions = new Map();
  const out3 = answerEscalationById(h.deps, 'nope', 'x');
  assert.equal(out3, null, 'unknown escalation returns null');

  console.log('escalation-answer assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('answering an escalation releases the parked deliberation on every transport', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /escalation-answer assertions passed/);
});
