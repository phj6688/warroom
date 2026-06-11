// HLB-152 — per-session token accounting.
//
// A single deliberation spends tokens in many places: agent turns, the
// Research Scout tool round-trip loop, quality scoring, the memory analyzer,
// and embedding calls. Each LLM call the model gateway answers carries a
// `usage` object, but the two transports report different shapes:
//
//   Anthropic SDK: { input_tokens, output_tokens,
//                    cache_read_input_tokens?, cache_creation_input_tokens? }
//   OpenAI-compatible gateway: { prompt_tokens, completion_tokens, total_tokens }
//
// normalizeUsage() collapses both into one { input_tokens, output_tokens,
// total_tokens } shape. The ledger keys a running tally by session id, split by
// purpose, so a completed session can persist a grand total and a per-purpose
// breakdown for later analytics and pricing.

'use strict';

// Purposes a session's tokens are attributed to. Kept stable so the persisted
// token_breakdown JSON has a predictable shape across versions. `meta` covers
// pre/non-deliberation LLM calls that still belong to the session, e.g. the
// fingerprint classifier that shapes the agent roster.
const CATEGORIES = ['agent_turn', 'tool_call', 'quality', 'memory', 'embedding', 'meta'];

function n(v) {
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * Collapse a provider usage object into { input_tokens, output_tokens,
 * total_tokens }. Handles both the Anthropic and OpenAI-compatible shapes and
 * returns zeros for null/garbage input. Anthropic cache buckets count toward
 * the input side because they are billed input tokens.
 */
function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }

  // Anthropic shape.
  if (raw.input_tokens != null || raw.output_tokens != null
      || raw.cache_read_input_tokens != null || raw.cache_creation_input_tokens != null) {
    const input = n(raw.input_tokens)
      + n(raw.cache_read_input_tokens)
      + n(raw.cache_creation_input_tokens);
    const output = n(raw.output_tokens);
    return { input_tokens: input, output_tokens: output, total_tokens: input + output };
  }

  // OpenAI-compatible shape.
  if (raw.prompt_tokens != null || raw.completion_tokens != null || raw.total_tokens != null) {
    const input = n(raw.prompt_tokens);
    const output = n(raw.completion_tokens);
    // Prefer the gateway's reported total when present; otherwise derive it.
    const total = raw.total_tokens != null ? n(raw.total_tokens) : input + output;
    return { input_tokens: input, output_tokens: output, total_tokens: total };
  }

  return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
}

/**
 * Add two normalized usage objects. Returns a fresh object.
 */
function sumUsage(a, b) {
  const x = normalizeUsage(a);
  const y = normalizeUsage(b);
  return {
    input_tokens: x.input_tokens + y.input_tokens,
    output_tokens: x.output_tokens + y.output_tokens,
    total_tokens: x.total_tokens + y.total_tokens,
  };
}

function emptyCategory() {
  return { input_tokens: 0, output_tokens: 0, total_tokens: 0, calls: 0, estimated: 0 };
}

function emptyBreakdown() {
  const bd = {};
  for (const c of CATEGORIES) bd[c] = emptyCategory();
  return bd;
}

/**
 * Per-session token ledger. Lives for the process lifetime; a session's tally
 * is dropped via clear() once persisted so a long-running server does not
 * accumulate completed sessions in memory.
 */
function createTokenLedger() {
  const bySession = new Map();

  function tallyFor(sessionId) {
    let t = bySession.get(sessionId);
    if (!t) { t = emptyBreakdown(); bySession.set(sessionId, t); }
    return t;
  }

  /**
   * Attribute one call's usage to a session/category. `usage` may be either
   * provider shape (it is normalized here). For embeddings the optional
   * { estimated: true } flag marks the figure as a char-count fallback rather
   * than a provider-reported count.
   */
  function add(sessionId, category, usage, opts = {}) {
    if (!sessionId) return;
    const cat = CATEGORIES.includes(category) ? category : 'agent_turn';
    const u = normalizeUsage(usage);
    const t = tallyFor(sessionId);
    const bucket = t[cat];
    bucket.input_tokens += u.input_tokens;
    bucket.output_tokens += u.output_tokens;
    bucket.total_tokens += u.total_tokens;
    bucket.calls += 1;
    if (opts.estimated) bucket.estimated += u.total_tokens;
  }

  /**
   * Read-only view: { total_tokens, token_breakdown }. Unknown sessions return
   * a fully zeroed shape rather than throwing, so the completion path can
   * always persist something.
   */
  function snapshot(sessionId) {
    const t = bySession.get(sessionId) || emptyBreakdown();
    // Deep copy so callers cannot mutate the live tally.
    const token_breakdown = {};
    let total = 0;
    for (const c of CATEGORIES) {
      token_breakdown[c] = { ...t[c] };
      total += t[c].total_tokens;
    }
    return { total_tokens: total, token_breakdown };
  }

  function clear(sessionId) {
    bySession.delete(sessionId);
  }

  return { add, snapshot, clear };
}

/**
 * Persist a session's running tally to its sessions row. Writes total_tokens
 * and the token_breakdown JSON and returns the snapshot. Idempotent: the
 * snapshot is the full cumulative tally, so re-persisting after later post-
 * deliberation work (embeddings, memory, quality) simply overwrites with the
 * newer, larger totals. Pass { clear: true } to drop the in-memory tally after
 * the final write so a long-running process does not retain completed sessions.
 * The UPDATE is a no-op if the row does not exist.
 */
function persistSessionTokens(db, sessionId, ledger, opts = {}) {
  const snap = ledger.snapshot(sessionId);
  try {
    db.prepare('UPDATE sessions SET total_tokens = ?, token_breakdown = ?, updated_at = ? WHERE id = ?')
      .run(snap.total_tokens, JSON.stringify(snap.token_breakdown), Date.now(), sessionId);
  } finally {
    if (opts.clear) ledger.clear(sessionId);
  }
  return snap;
}

/**
 * HLB-335 — throttle gate for live token-tick broadcasts. shouldEmit returns
 * true at most once per intervalMs per session (the clock is passed in so it is
 * deterministically testable). The first call for a session always emits, so the
 * counter starts moving on the first accrual; reset() drops a session's timer at
 * completion so a long-running process does not retain finished sessions.
 */
function createTickThrottle(intervalMs) {
  const last = new Map();
  return {
    shouldEmit(sessionId, now) {
      if (!sessionId) return false;
      const prev = last.get(sessionId);
      if (prev === undefined || now - prev >= intervalMs) {
        last.set(sessionId, now);
        return true;
      }
      return false;
    },
    reset(sessionId) { last.delete(sessionId); },
  };
}

module.exports = {
  CATEGORIES,
  normalizeUsage,
  sumUsage,
  createTokenLedger,
  persistSessionTokens,
  createTickThrottle,
};
