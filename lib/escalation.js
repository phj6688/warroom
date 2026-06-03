// F13 — Event-driven escalation wait.
//
// Replaces the 2-second polling loop in runDeliberation with a per-escalation
// promise the WS handler resolves the moment an answer arrives. Wakeup latency
// drops from up to 2 s to <100 ms.
//
// HLB-148 — the fixed 5-minute setTimeout is now a per-escalation MUTABLE
// deadline the human controls from the card:
//   - pause  suspends the countdown so the wait will not auto-resolve
//   - reset  restarts the window from now
// A single self-rescheduling check (not a one-shot timer) compares the live
// clock against `deadlineAt` each wakeup, so pushing the deadline out (reset) or
// suspending it (pause) takes effect without re-arming anything. getDeadline()
// is the read seam the server uses to send `deadlineAt` + `paused` to the
// client.
//
// API:
//   waitForEscalation(sessionId, escalationId, { timeoutMs }) → Promise<answer>
//   resolveEscalation(sessionId, escalationId, answer)
//   pauseEscalation(sessionId, escalationId)   — suspend the countdown
//   resetEscalation(sessionId, escalationId)   — restart the window from now
//   getDeadline(sessionId, escalationId) → { deadlineAt, paused } | null
//   abortSessionWaits(sessionId, reason)   — used by stop-session to release
//                                            any pending waits for a killed
//                                            session
//
// Module-level state: a Map keyed by `${sessionId}:${escalationId}` whose value
// is `{ resolve, reject, timer, durationMs, deadlineAt, paused }`. The map is
// process-local; multi-instance handling is out of scope (S14).

const { log } = require('./logger');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
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
// until reset (or an explicit answer / abort). Returns false for an unknown id.
function pauseEscalation(sessionId, escalationId) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  w.paused = true;
  return true;
}

// Restart the window from now and clear the paused flag. The next tick honors
// the new deadline. Returns false for an unknown id.
function resetEscalation(sessionId, escalationId) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  w.paused = false;
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

module.exports = {
  waitForEscalation,
  resolveEscalation,
  pauseEscalation,
  resetEscalation,
  getDeadline,
  abortSessionWaits,
  pendingCount,
  DEFAULT_TIMEOUT_MS,
};
