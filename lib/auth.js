// Bearer auth gate for HTTP and WebSocket. Constant-time compare via
// crypto.timingSafeEqual. WAR_ROOM_TOKEN unset → unauth mode + warn.
// See forge/hardening/SCARS.md §S01.

const crypto = require('crypto');

const TOKEN = (process.env.WAR_ROOM_TOKEN || '').trim();
const UNAUTH_MODE = TOKEN === '';

if (UNAUTH_MODE) {
  console.warn('⚠️  [auth] WAR_ROOM_TOKEN unset — running in UNAUTHENTICATED mode (homelab default). Set WAR_ROOM_TOKEN in .env to gate /api/* and the WebSocket upgrade.');
} else {
  console.log('🔒 [auth] WAR_ROOM_TOKEN configured — bearer auth enabled');
}

function constantTimeMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
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

// Express middleware. Unauth mode → next(). Otherwise require Bearer match.
function requireAuth(req, res, next) {
  if (UNAUTH_MODE) return next();
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
  if (UNAUTH_MODE) return true;
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

module.exports = { requireAuth, requireAuthWS, UNAUTH_MODE };
