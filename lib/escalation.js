// F13 — Event-driven escalation wait.
//
// Replaces the 2-second polling loop in runDeliberation with a per-escalation
// promise the WS handler resolves the moment an answer arrives. Wakeup latency
// drops from up to 2 s to <100 ms.
//
// API:
//   waitForEscalation(sessionId, escalationId, { timeoutMs }) → Promise<answer>
//   resolveEscalation(sessionId, escalationId, answer)
//   abortSessionWaits(sessionId, reason)   — used by stop-session to release
//                                            any pending waits for a killed
//                                            session
//
// Module-level state: a Map keyed by `${sessionId}:${escalationId}` whose
// value is `{ resolve, reject, timer }`. The map is process-local; multi-
// instance handling is out of scope (S14).

const { log } = require('./logger');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const waiters = new Map();

function key(sessionId, escalationId) {
  return `${sessionId}:${escalationId}`;
}

function waitForEscalation(sessionId, escalationId, opts = {}) {
  const k = key(sessionId, escalationId);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const w = waiters.get(k);
      if (w) {
        waiters.delete(k);
        w.reject(new Error('escalation wait timed out'));
      }
    }, timeoutMs);
    // Intentionally NOT unref'd: while a wait is active the process should
    // stay alive so the timeout (or the resolve) can fire. shutdown() and
    // abortSessionWaits() are responsible for releasing waits cleanly.

    waiters.set(k, { resolve, reject, timer });
  });
}

function resolveEscalation(sessionId, escalationId, answer) {
  const k = key(sessionId, escalationId);
  const w = waiters.get(k);
  if (!w) return false;
  waiters.delete(k);
  clearTimeout(w.timer);
  w.resolve(answer);
  return true;
}

function abortSessionWaits(sessionId, reason = 'session stopped') {
  const prefix = `${sessionId}:`;
  let aborted = 0;
  for (const [k, w] of waiters) {
    if (k.startsWith(prefix)) {
      waiters.delete(k);
      clearTimeout(w.timer);
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
  abortSessionWaits,
  pendingCount,
};
