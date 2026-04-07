// F9 — Structured logging.
//
// Single pino instance for the whole process. JSON output by default so log
// shippers (and `jq`) can consume it without a parser. LOG_LEVEL env var
// honored, default `info`.
//
// Helpers:
//   withSession(sessionId) → child logger that tags every line with sessionId
//   withRequest(reqId)     → child logger that tags every line with reqId
//
// pino-pretty is intentionally NOT a dependency. Operators who want
// human-readable local output can pipe through `npx pino-pretty` themselves.

const pino = require('pino');

// Logs go to STDERR. Several child-process-driven tests parse the host's
// STDOUT as JSON, and the MCP stdio transport expects clean stdout too —
// keeping log lines on stderr lets both work without coordination. Operators
// who want a single stream can `2>&1` themselves.
const log = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    // Emit level as the human-readable label ("warn") instead of the numeric
    // code (40). Marginally larger lines, but log shippers and grep both
    // benefit, and the test suite asserts level keywords directly.
    formatters: {
      level(label) { return { level: label }; },
    },
  },
  pino.destination(2)
);

function withSession(sessionId) {
  return log.child({ sessionId });
}

function withRequest(reqId) {
  return log.child({ reqId });
}

module.exports = { log, withSession, withRequest };
