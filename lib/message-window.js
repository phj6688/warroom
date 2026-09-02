'use strict';

/**
 * Cursor paging over a session's message log.
 *
 * A cursor is an ordinal watermark: `since: 12` means "everything the room said
 * after its 12th message". Messages are append-only and always read in one
 * deterministic order, so a position stays valid between polls without a clock,
 * an id scheme, or any server-side cursor state.
 *
 * The watermark counts the whole log, never the filtered view. `since: 12`
 * therefore means the same thing with or without an agent or phase filter:
 * filters narrow what a page returns, they never move the cursor.
 *
 * Both MCP transports share this module. The HTTP one reads rows from SQLite
 * and the stdio one from REST, so the two row shapes differ (snake_case vs
 * camelCase) and every read here accepts both.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function agentIdOf(row) { return row.agent_id ?? row.agentId ?? null; }
function agentNameOf(row) { return row.agent_name ?? row.agentName ?? null; }
function agentEmojiOf(row) { return row.agent_emoji ?? row.agentEmoji ?? ''; }
function createdAtOf(row) { return row.created_at ?? row.timestamp ?? null; }

// A cursor past the end of the log is a caught-up poller, not an error: clamp
// it rather than answering with a page the caller cannot reconcile.
function normalizeSince(since, total) {
  const n = Number(since);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), total);
}

function normalizeLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Take one page of `rows` (the session's full log, in cursor order).
 * Returns the page plus the cursor that reads whatever lands next.
 */
function windowMessages(rows, { agentId, phase, since, limit } = {}) {
  const log = rows || [];
  const total = log.length;
  const from = normalizeSince(since, total);
  const cap = normalizeLimit(limit);

  const messages = [];
  // Where the next read resumes. It advances over every row this call consumed,
  // matching or not, so a poll that filters everything out still moves forward
  // instead of rescanning the same tail on the next tick.
  let nextCursor = from;
  let truncated = false;

  for (let i = from; i < total; i++) {
    if (messages.length >= cap) { truncated = true; break; }
    const row = log[i];
    nextCursor = i + 1;
    if (agentId && agentIdOf(row) !== agentId) continue;
    if (phase && row.phase !== phase) continue;
    messages.push({ ...row, seq: i + 1 });
  }

  return {
    messages,
    total,
    since: from,
    nextCursor,
    truncated,
    remaining: total - nextCursor,
  };
}

/**
 * What a status poll needs in place of the transcript: how much the room has
 * said, where it said it, and when it last spoke.
 */
function summarizeMessages(rows) {
  const log = rows || [];
  const byPhase = [];
  const seen = new Map();
  for (const row of log) {
    const phase = row.phase || '(none)';
    if (!seen.has(phase)) { seen.set(phase, byPhase.length); byPhase.push({ phase, count: 0 }); }
    byPhase[seen.get(phase)].count++;
  }
  const last = log.length ? log[log.length - 1] : null;
  return {
    total: log.length,
    cursor: log.length,
    byPhase,
    latest: last ? {
      agentName: agentNameOf(last),
      agentEmoji: agentEmojiOf(last),
      phase: last.phase,
      at: createdAtOf(last),
    } : null,
  };
}

module.exports = { windowMessages, summarizeMessages, DEFAULT_LIMIT, MAX_LIMIT };
