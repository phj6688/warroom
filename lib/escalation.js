// F13 — Event-driven escalation wait.
//
// Replaces the 2-second polling loop in runDeliberation with a per-escalation
// promise the WS handler resolves the moment an answer arrives. Wakeup latency
// drops from up to 2 s to <100 ms.
//
// HLB-148: the fixed 5-minute setTimeout is now a per-escalation MUTABLE
// deadline the human controls from the card:
//   - pause   suspends the countdown so the wait will not auto-resolve; the
//             remaining time is snapshotted at the pause edge
//   - resume  continues the countdown from the remaining-at-pause (NOT a fresh
//             full window, that is reset)
//   - reset   restarts a FRESH full window from now
// A single self-rescheduling check (not a one-shot timer) compares the live
// clock against `deadlineAt` each wakeup, so pushing the deadline out (reset) or
// suspending it (pause) takes effect without re-arming anything. getDeadline()
// is the read seam the server uses to send `deadlineAt` + `paused` to the
// client.
//
// API:
//   waitForEscalation(sessionId, escalationId, { timeoutMs }) → Promise<answer>
//   resolveEscalation(sessionId, escalationId, answer)
//   pauseEscalation(sessionId, escalationId)   suspend the countdown
//   resumeEscalation(sessionId, escalationId)  continue from remaining-at-pause
//   resetEscalation(sessionId, escalationId)   restart a fresh full window
//   getDeadline(sessionId, escalationId) → { deadlineAt, paused } | null
//   abortSessionWaits(sessionId, reason)   — used by stop-session to release
//                                            any pending waits for a killed
//                                            session
//
// Module-level state: a Map keyed by `${sessionId}:${escalationId}` whose value
// is `{ resolve, reject, timer, durationMs, deadlineAt, paused, remainingMs }`.
// remainingMs is the time-left snapshot taken on the pause edge so resume can
// continue from there. The map is process-local; multi-instance handling is out
// of scope (S14).

const { log } = require('./logger');

// How long a blocking escalation holds the room before it resolves to the
// agent's stated default. Env-settable so the behaviour can be driven in a
// test without a five-minute wait.
const DEFAULT_TIMEOUT_MS = (() => {
  const n = Number.parseInt(process.env.ESCALATION_TIMEOUT_MS || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 5 * 60 * 1000;
})();
// How often the countdown checks the clock. Small enough that a fired deadline
// resolves promptly, large enough not to busy-spin. The wait still ends within
// one tick of the real deadline.
const TICK_MS = 250;
const waiters = new Map();

function key(sessionId, escalationId) {
  return `${sessionId}:${escalationId}`;
}

function fireTimeout(k) {
  const w = waiters.get(k);
  if (!w) return;
  waiters.delete(k);
  if (w.timer) clearTimeout(w.timer);
  w.reject(new Error('escalation wait timed out'));
}

// Self-rescheduling check. On each tick: if paused, do nothing but keep ticking;
// if the live deadline has passed, fire the timeout; otherwise sleep until the
// deadline (capped at one TICK_MS so a mid-flight reset/pause is observed soon).
function scheduleCheck(k) {
  const w = waiters.get(k);
  if (!w) return;
  const now = Date.now();
  let wait;
  if (w.paused) {
    wait = TICK_MS;
  } else {
    const remaining = w.deadlineAt - now;
    if (remaining <= 0) { fireTimeout(k); return; }
    wait = Math.min(remaining, TICK_MS);
  }
  w.timer = setTimeout(() => scheduleCheck(k), wait);
  // Intentionally NOT unref'd: while a wait is active the process should stay
  // alive so the timeout (or the resolve) can fire. shutdown() and
  // abortSessionWaits() are responsible for releasing waits cleanly.
}

function waitForEscalation(sessionId, escalationId, opts = {}) {
  const k = key(sessionId, escalationId);
  const durationMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const entry = {
      resolve,
      reject,
      timer: null,
      durationMs,
      deadlineAt: Date.now() + durationMs,
      paused: false,
    };
    waiters.set(k, entry);
    scheduleCheck(k);
  });
}

function resolveEscalation(sessionId, escalationId, answer) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  waiters.delete(k);
  if (w.timer) clearTimeout(w.timer);
  w.resolve(answer);
  return true;
}

// Suspend the countdown. The waiter stays registered and will NOT auto-resolve
// until resume/reset (or an explicit answer / abort). The time left at the
// moment of pause is snapshotted so resume can continue from exactly there.
// Returns false for an unknown id.
function pauseEscalation(sessionId, escalationId) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  if (!w.paused) {
    // Snapshot only on the pause edge so a double-pause doesn't keep shrinking
    // the remaining time. Floor at 0, a deadline already in the past resumes
    // to an immediate fire, never to a negative window.
    w.remainingMs = Math.max(0, w.deadlineAt - Date.now());
  }
  w.paused = true;
  return true;
}

// Continue the countdown from where pause left it: deadline = now + the time
// that remained at pause. This is TRUE resume: it does NOT hand back a fresh
// full window (that is reset). Clears the paused flag so the next tick honors
// the deadline. Returns false for an unknown id.
function resumeEscalation(sessionId, escalationId) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  // If resume is called without a prior pause snapshot, fall back to the time
  // still on the clock (resume becomes a no-op continuation rather than a grant).
  const remaining = typeof w.remainingMs === 'number'
    ? w.remainingMs
    : Math.max(0, w.deadlineAt - Date.now());
  w.deadlineAt = Date.now() + remaining;
  w.paused = false;
  w.remainingMs = undefined;
  return true;
}

// Restart the window from now and clear the paused flag: a FRESH full window
// (the durationMs the wait was created with), distinct from resume. The next
// tick honors the new deadline. Returns false for an unknown id.
function resetEscalation(sessionId, escalationId) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  w.paused = false;
  w.remainingMs = undefined;
  w.deadlineAt = Date.now() + w.durationMs;
  return true;
}

// Read seam for the server: the live deadline + paused flag the client renders.
// Null when there is no active waiter (answered / never started / inactive).
function getDeadline(sessionId, escalationId) {
  const w = waiters.get(key(sessionId, escalationId));
  if (!w) return null;
  return { deadlineAt: w.deadlineAt, paused: w.paused };
}

function abortSessionWaits(sessionId, reason = 'session stopped') {
  const prefix = `${sessionId}:`;
  let aborted = 0;
  for (const [k, w] of waiters) {
    if (k.startsWith(prefix)) {
      waiters.delete(k);
      if (w.timer) clearTimeout(w.timer);
      w.reject(new Error(reason));
      aborted++;
    }
  }
  if (aborted > 0) log.debug({ sessionId, aborted }, 'escalation waits aborted');
  return aborted;
}

function pendingCount() {
  return waiters.size;
}

// Answer one escalation, whatever transport carried the answer. Four things
// have to happen together: persist it, update the live session object, release
// the deliberation parked on it, and tell the clients. The MCP path used to do
// the first two only, so an answer sent over MCP left the room parked on its
// full 5-minute wait while the caller believed it had unblocked the room.
// Both transports share this routine so they cannot drift apart again.
//
// Returns { sessionId, resolved } — `resolved` is true when a parked wait was
// released — or null when no such escalation exists.
function answerEscalationById({ stmts, activeSessions, broadcast }, escalationId, answer, extra = {}) {
  let sessionId = null;
  let esc = null;
  for (const [id, session] of (activeSessions || [])) {
    const found = (session.escalations || []).find(e => e.id === escalationId);
    if (found) { sessionId = id; esc = found; break; }
  }
  // An escalation from a session that is no longer running is still answerable:
  // the answer belongs in the record even when there is no waiter to wake.
  if (!sessionId && stmts && stmts.getEscalation) {
    const row = stmts.getEscalation.get(escalationId);
    if (row) sessionId = row.session_id;
  }
  if (!sessionId) return null;

  stmts.answerEscalation.run(answer, Date.now(), escalationId);
  if (esc) { esc.answered = true; esc.answer = answer; }
  const resolved = resolveEscalation(sessionId, escalationId, answer);
  if (typeof broadcast === 'function') {
    broadcast(sessionId, { type: 'escalation-answered', escalationId, answer, sessionId, ...extra });
  }
  return { sessionId, resolved };
}

// The text a timed-out or bulk-resolved escalation is closed with. An agent
// states its own fallback when it raises the question; honor that before the
// generic wording.
function defaultAnswerFor(esc, prefix) {
  return esc && esc.defaultAction
    ? `${prefix} ${esc.defaultAction}`
    : `${prefix} No human answer; proceed with your stated default / best judgment.`;
}

module.exports = {
  waitForEscalation,
  resolveEscalation,
  answerEscalationById,
  defaultAnswerFor,
  pauseEscalation,
  resumeEscalation,
  resetEscalation,
  getDeadline,
  abortSessionWaits,
  pendingCount,
  DEFAULT_TIMEOUT_MS,
};
