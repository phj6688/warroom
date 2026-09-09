// Bearer auth gate for HTTP and WebSocket. Constant-time compare via
// crypto.timingSafeEqual.
//
// A missing WAR_ROOM_TOKEN is a configuration error, not a mode. Absent, empty
// or whitespace-only, the process refuses to start instead of serving /api/*
// and the WebSocket upgrade to anonymous callers. The previous behaviour turned
// a lost secret into an open deployment with nothing but one warn line to say
// so, and a warn line is invisible once the app has been up for a week.
//
// A developer who wants an open local instance asks for it by name:
//   WAR_ROOM_ALLOW_ANONYMOUS=true
// It defaults to off, and it is refused when NODE_ENV=production, which the
// container image sets. The absence of a value never implies development.
//
// The refusal is `assertAuthGateConfigured`, which the entry point calls before
// it binds a port. `requireAuth` and `requireAuthWS` reject on their own with no
// token, so a build that skipped the assertion would be useless rather than open.
//
// See forge/hardening/SCARS.md §S01.

const fs = require('fs');
const crypto = require('crypto');
const { log } = require('./logger');

const TOKEN = (process.env.WAR_ROOM_TOKEN || '').trim();
const IS_PRODUCTION = (process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const ANONYMOUS_OPT_IN = (process.env.WAR_ROOM_ALLOW_ANONYMOUS || '').trim().toLowerCase() === 'true';

// sysexits.h EX_CONFIG. It separates "the configuration is wrong" from a crash
// when an operator reads `docker inspect` or a restart loop.
const EX_CONFIG = 78;

function refuseToStart(reason) {
  // fs.writeSync on fd 2 rather than the pino stream alone. Under Docker stderr
  // is a pipe, so a buffered line can be lost when the process exits in the
  // same tick, and this is the one line the operator needs.
  const line = `war-room: refusing to start. ${reason}\n`;
  try { fs.writeSync(2, line); } catch (_) { /* stderr closed; the log below is the fallback */ }
  try { log.fatal({ authState: 'refusing-to-start' }, reason); } catch (_) {}
  process.exit(EX_CONFIG);
}

// The whole condition, not the leftovers of the checks below. Deleting a check
// must not be enough to reopen the gate: with no token and no opt-in this stays
// false, and `constantTimeMatches` refuses an empty token, so every protected
// route and every upgrade rejects even if the boot assertion never runs.
const ANONYMOUS_ACCESS = TOKEN === '' && ANONYMOUS_OPT_IN && !IS_PRODUCTION;

// The entry point calls this before it binds a port. It is deliberately not run
// on require: lib/routes exports pure helpers that tests load in-process, and a
// module that kills its importer is the wrong tool for a boot check.
function assertAuthGateConfigured() {
  if (TOKEN !== '') {
    log.info({ authState: 'enforced' }, 'WAR_ROOM_TOKEN configured, bearer auth enforced on /api/* and the WebSocket upgrade');
    return;
  }

  if (!ANONYMOUS_OPT_IN) {
    refuseToStart(
      'WAR_ROOM_TOKEN is unset, empty or whitespace, so /api/* and the WebSocket upgrade would have no gate. ' +
      'Set WAR_ROOM_TOKEN, or set WAR_ROOM_ALLOW_ANONYMOUS=true to run an open instance locally.'
    );
  }

  if (IS_PRODUCTION) {
    refuseToStart(
      'WAR_ROOM_ALLOW_ANONYMOUS is not honoured when NODE_ENV=production. Set WAR_ROOM_TOKEN.'
    );
  }

  log.warn(
    { authState: 'anonymous' },
    'WAR_ROOM_ALLOW_ANONYMOUS=true with no WAR_ROOM_TOKEN: /api/* and the WebSocket upgrade accept any caller. Local development only.'
  );
}

// What the gate is doing right now, for /health, /api/health and /metrics. An
// operator should not have to send a probe request to find out.
function authPosture() {
  return ANONYMOUS_ACCESS ? 'anonymous' : 'enforced';
}

function constantTimeMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  if (TOKEN === '') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearer(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue);
  return m ? m[1].trim() : null;
}

// Express middleware. Requires a Bearer match unless this instance was
// explicitly started in anonymous mode.
function requireAuth(req, res, next) {
  if (ANONYMOUS_ACCESS) return next();
  const provided = extractBearer(req.headers && req.headers.authorization);
  if (!provided || !constantTimeMatches(provided)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

// WebSocket upgrade auth. Returns true if the request should proceed.
// Accepts the token from any of: Authorization header (Bearer), `?token=` query
// param, or Sec-WebSocket-Protocol header (browsers can't set arbitrary headers
// on WebSocket connections, so the protocol field is the standard escape hatch).
function requireAuthWS(req) {
  if (ANONYMOUS_ACCESS) return true;
  const headerToken = extractBearer(req.headers && req.headers.authorization);
  if (headerToken && constantTimeMatches(headerToken)) return true;

  const url = req.url || '';
  const qIdx = url.indexOf('?');
  if (qIdx >= 0) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const qToken = params.get('token');
    if (qToken && constantTimeMatches(qToken)) return true;
  }

  const proto = req.headers && req.headers['sec-websocket-protocol'];
  if (typeof proto === 'string') {
    for (const p of proto.split(',').map(s => s.trim())) {
      if (constantTimeMatches(p)) return true;
    }
  }

  return false;
}

module.exports = { assertAuthGateConfigured, requireAuth, requireAuthWS, authPosture, ANONYMOUS_ACCESS };
