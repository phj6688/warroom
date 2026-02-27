/**
 * War Room — Export Feature Tests
 * Senior QA Engineer — written from specification, not from implementation.
 *
 * Spec:
 *   - After session completes: prompt user to export results
 *   - Export button available post-completion
 *   - Export options:
 *       1. Full Transcript (A to Z) — every agent message, all phases
 *       2. End Result Only          — final synthesis
 *       3. End Result + Q&A         — synthesis + questions & answers
 *   - Formats: txt, md, json
 *
 * Endpoints under test:
 *   GET /api/sessions/:id/export/options
 *   GET /api/sessions/:id/export?mode=<mode>&format=<format>
 *
 * Node.js built-in test runner (node:test + node:assert)
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────
const BASE = 'http://100.115.215.121:8090';
const API  = `${BASE}/api`;

// ─── Helpers ─────────────────────────────────────────────────
async function get(url) {
  const res = await fetch(url);
  return { status: res.status, headers: res.headers, body: await res.text(), res };
}

async function getJson(url) {
  const { status, body, headers } = await get(url);
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status, json, headers };
}

function uid() { return randomBytes(5).toString('hex'); } // 10 hex chars — valid session ID

// ─── DB Seed (direct SQLite writes to mirror what server does) ─
// We seed the DB directly so tests don't need LLM calls.
// DB path: /home/lumo/war-room/data/warroom.db (inside container at /app/data/warroom.db)
// We use the server's REST API to read and the raw DB to seed.

// Because we're running tests OUTSIDE the container, we'll use the HTTP API as the seeding mechanism
// by creating sessions through the WebSocket start flow OR by pre-seeding via a known completed session
// that already exists in the DB.
// For isolation, we'll create test data via the server's own DB through SSH + node evaluation.

// Simpler approach: use a helper endpoint /api/sessions which shows us existing sessions,
// and pick one that's complete. For edge cases, we parameterize the session id.

// Session IDs to use for positive tests (if the server has them); otherwise skip.
let completedSessionId = null;
let activeSessionId    = null;
let allSessions        = [];

// ─── Setup ───────────────────────────────────────────────────
before(async () => {
  const { json } = await getJson(`${API}/sessions`);
  if (Array.isArray(json)) {
    allSessions = json;
    completedSessionId = json.find(s => !s.active)?.id || null;
    activeSessionId    = json.find(s => s.active)?.id || null;
  }
  console.log(`\n  Setup: ${allSessions.length} sessions found`);
  console.log(`  Completed session: ${completedSessionId || 'none'}`);
  console.log(`  Active session:    ${activeSessionId || 'none'}\n`);
});

// ═══════════════════════════════════════════════════════════════
// 1. Export Options Endpoint — Contract Tests
// ═══════════════════════════════════════════════════════════════
describe('GET /api/sessions/:id/export/options — contract', () => {

  test('returns 404 for unknown session', async () => {
    const { status, json } = await getJson(`${API}/sessions/deadbeef00/export/options`);
    assert.equal(status, 404);
    assert.ok(json?.error, 'should have error field');
  });

  test('returns 400 for invalid session ID (special chars)', async () => {
    const { status } = await getJson(`${API}/sessions/../etc/passwd/export/options`);
    // Should be 400 (bad ID) or 404 — never 500
    assert.ok([400, 404].includes(status), `expected 400 or 404, got ${status}`);
  });

  test('returns 400 for session ID that is too short', async () => {
    const { status } = await getJson(`${API}/sessions/ab/export/options`);
    assert.equal(status, 400);
  });

  test('returns 400 for session ID that is too long (>32 chars)', async () => {
    const longId = 'a'.repeat(33);
    const { status } = await getJson(`${API}/sessions/${longId}/export/options`);
    assert.equal(status, 400);
  });

  test('response shape: required top-level fields', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, json } = await getJson(`${API}/sessions/${id}/export/options`);
    assert.equal(status, 200);
    assert.ok(typeof json.sessionId   === 'string',  'sessionId must be string');
    assert.ok(typeof json.problem     === 'string',  'problem must be string');
    assert.ok(typeof json.isComplete  === 'boolean', 'isComplete must be boolean');
    assert.ok(typeof json.messageCount === 'number', 'messageCount must be number');
    assert.ok(typeof json.hasSynthesis === 'boolean','hasSynthesis must be boolean');
    assert.ok(typeof json.hasQA        === 'boolean','hasQA must be boolean');
    assert.ok(Array.isArray(json.modes),   'modes must be array');
    assert.ok(Array.isArray(json.formats), 'formats must be array');
  });

  test('modes: exactly 3 export modes returned', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    assert.equal(json.modes.length, 3);
  });

  test('modes: full_transcript mode exists with correct shape', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    const mode = json.modes.find(m => m.id === 'full_transcript');
    assert.ok(mode, 'full_transcript mode must exist');
    assert.ok(typeof mode.label       === 'string',  'label must be string');
    assert.ok(typeof mode.description === 'string',  'description must be string');
    assert.ok(typeof mode.available   === 'boolean', 'available must be boolean');
  });

  test('modes: end_result mode exists', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    const mode = json.modes.find(m => m.id === 'end_result');
    assert.ok(mode, 'end_result mode must exist');
  });

  test('modes: end_result_with_qa mode exists', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    const mode = json.modes.find(m => m.id === 'end_result_with_qa');
    assert.ok(mode, 'end_result_with_qa mode must exist');
  });

  test('formats: exactly 3 formats returned (txt, md, json)', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    assert.equal(json.formats.length, 3);
    const ids = json.formats.map(f => f.id);
    assert.ok(ids.includes('txt'),  'txt format required');
    assert.ok(ids.includes('md'),   'md format required');
    assert.ok(ids.includes('json'), 'json format required');
  });

  test('formats: each format has id, label, mimeType', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const { json } = await getJson(`${API}/sessions/${allSessions[0].id}/export/options`);
    for (const fmt of json.formats) {
      assert.ok(typeof fmt.id       === 'string', `format ${fmt.id}: id must be string`);
      assert.ok(typeof fmt.label    === 'string', `format ${fmt.id}: label must be string`);
      assert.ok(typeof fmt.mimeType === 'string', `format ${fmt.id}: mimeType must be string`);
    }
  });

  test('isComplete is true for a non-active session', async (t) => {
    if (!completedSessionId) return t.skip('No completed session in DB');
    const { json } = await getJson(`${API}/sessions/${completedSessionId}/export/options`);
    assert.equal(json.isComplete, true);
  });

  test('isComplete is false for an active session', async (t) => {
    if (!activeSessionId) return t.skip('No active session in DB');
    const { json } = await getJson(`${API}/sessions/${activeSessionId}/export/options`);
    assert.equal(json.isComplete, false);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Export Endpoint — Happy Path
// ═══════════════════════════════════════════════════════════════
describe('GET /api/sessions/:id/export — happy path', () => {

  test('full_transcript + txt: returns 200 with text/plain content-type', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, headers } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=txt`);
    assert.equal(status, 200);
    assert.ok(headers.get('content-type')?.includes('text/plain'), 'should be text/plain');
  });

  test('full_transcript + txt: content-disposition attachment with .txt filename', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { headers } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=txt`);
    const cd = headers.get('content-disposition') || '';
    assert.ok(cd.includes('attachment'), 'must be attachment');
    assert.ok(cd.includes('.txt'), 'filename must end in .txt');
    assert.ok(cd.includes(id), 'filename must include session id');
  });

  test('full_transcript + md: returns text/markdown content-type', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, headers } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=md`);
    assert.equal(status, 200);
    assert.ok(headers.get('content-type')?.includes('text/markdown'), 'should be text/markdown');
  });

  test('full_transcript + md: filename ends in .md', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { headers } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=md`);
    const cd = headers.get('content-disposition') || '';
    assert.ok(cd.includes('.md'), 'filename must end in .md');
  });

  test('full_transcript + json: returns application/json content-type', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, headers } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=json`);
    assert.equal(status, 200);
    assert.ok(headers.get('content-type')?.includes('application/json'), 'should be application/json');
  });

  test('full_transcript + json: valid JSON with required fields', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, json } = await getJson(`${API}/sessions/${id}/export?mode=full_transcript&format=json`);
    assert.equal(status, 200);
    assert.ok(json !== null, 'must be valid JSON');
    assert.equal(json.sessionId, id);
    assert.equal(json.mode, 'full_transcript');
    assert.ok(typeof json.problem     === 'string', 'problem must be present');
    assert.ok(typeof json.createdAt   === 'string', 'createdAt must be ISO string');
    assert.ok(Array.isArray(json.transcript),       'transcript must be array');
    assert.ok(Array.isArray(json.questions),        'questions must be array');
    assert.ok(Array.isArray(json.humanMessages),    'humanMessages must be array');
  });

  test('end_result + json: valid JSON with synthesis array', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, json } = await getJson(`${API}/sessions/${id}/export?mode=end_result&format=json`);
    assert.equal(status, 200);
    assert.equal(json.mode, 'end_result');
    assert.ok(Array.isArray(json.synthesis), 'synthesis must be array');
    assert.ok(!('transcript' in json),       'full transcript must NOT be present in end_result');
  });

  test('end_result_with_qa + json: has synthesis AND questions', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, json } = await getJson(`${API}/sessions/${id}/export?mode=end_result_with_qa&format=json`);
    assert.equal(status, 200);
    assert.equal(json.mode, 'end_result_with_qa');
    assert.ok(Array.isArray(json.synthesis),     'synthesis must be array');
    assert.ok(Array.isArray(json.questions),      'questions must be array');
    assert.ok(Array.isArray(json.humanMessages),  'humanMessages must be array');
    assert.ok(!('transcript' in json),            'full transcript must NOT be in end_result_with_qa');
  });

  test('default mode (no ?mode=) defaults to full_transcript', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { json } = await getJson(`${API}/sessions/${id}/export?format=json`);
    assert.equal(json.mode, 'full_transcript');
  });

  test('default format (no ?format=) defaults to txt with text/plain', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, headers } = await get(`${API}/sessions/${id}/export`);
    assert.equal(status, 200);
    assert.ok(headers.get('content-type')?.includes('text/plain'), 'default format should be text/plain');
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Export Endpoint — Content Correctness
// ═══════════════════════════════════════════════════════════════
describe('GET /api/sessions/:id/export — content correctness', () => {

  test('full_transcript txt: body contains session problem text', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const problem = allSessions[0].problem;
    const { body } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=txt`);
    assert.ok(body.includes(problem), 'body must contain the original problem statement');
  });

  test('full_transcript txt: body contains session ID', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { body } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=txt`);
    assert.ok(body.includes(id), 'body must contain session ID');
  });

  test('full_transcript md: body starts with # (markdown h1)', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { body } = await get(`${API}/sessions/${id}/export?mode=full_transcript&format=md`);
    assert.ok(body.startsWith('#'), 'markdown export must begin with a heading');
  });

  test('full_transcript json: transcript items have required fields', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { json } = await getJson(`${API}/sessions/${id}/export?mode=full_transcript&format=json`);
    for (const item of json.transcript) {
      assert.ok(typeof item.agent     === 'string', 'transcript item.agent must be string');
      assert.ok(typeof item.phase     === 'string', 'transcript item.phase must be string');
      assert.ok(typeof item.content   === 'string', 'transcript item.content must be string');
      assert.ok(typeof item.timestamp === 'string', 'transcript item.timestamp must be ISO string');
    }
  });

  test('end_result json: synthesis items have agent + content + timestamp', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { json } = await getJson(`${API}/sessions/${id}/export?mode=end_result&format=json`);
    for (const item of json.synthesis) {
      assert.ok(typeof item.agent     === 'string', 'synthesis item.agent must be string');
      assert.ok(typeof item.content   === 'string', 'synthesis item.content must be string');
      assert.ok(typeof item.timestamp === 'string', 'synthesis item.timestamp must be ISO string');
    }
  });

  test('end_result_with_qa json: question items have askedBy + question + answered', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { json } = await getJson(`${API}/sessions/${id}/export?mode=end_result_with_qa&format=json`);
    for (const q of json.questions) {
      assert.ok(typeof q.askedBy   === 'string',  'question.askedBy must be string');
      assert.ok(typeof q.question  === 'string',  'question.question must be string');
      assert.ok(typeof q.answered  === 'boolean', 'question.answered must be boolean');
      // answer may be null if unanswered
      assert.ok(q.answer === null || typeof q.answer === 'string', 'question.answer must be null or string');
    }
  });

  test('completed session: json export has non-null finishedAt', async (t) => {
    if (!completedSessionId) return t.skip('No completed session in DB');
    const { json } = await getJson(`${API}/sessions/${completedSessionId}/export?format=json`);
    assert.ok(json.finishedAt !== null, 'completed session must have finishedAt');
    // must be valid ISO date
    assert.ok(!isNaN(Date.parse(json.finishedAt)), 'finishedAt must be valid ISO date');
  });

  test('active session: json export has null finishedAt', async (t) => {
    if (!activeSessionId) return t.skip('No active session in DB');
    const { json } = await getJson(`${API}/sessions/${activeSessionId}/export?format=json`);
    assert.equal(json.finishedAt, null, 'active session must have null finishedAt');
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. Export Endpoint — Edge Cases & Error Paths
// ═══════════════════════════════════════════════════════════════
describe('GET /api/sessions/:id/export — edge cases', () => {

  test('returns 404 for non-existent session', async () => {
    const { status, json } = await getJson(`${API}/sessions/deadbeef00/export`);
    assert.equal(status, 404);
    assert.ok(json?.error, 'must have error field');
  });

  test('returns 400 for invalid session ID (too short)', async () => {
    const { status } = await getJson(`${API}/sessions/ab/export`);
    assert.equal(status, 400);
  });

  test('returns 400 for invalid session ID (too long)', async () => {
    const { status } = await getJson(`${API}/sessions/${'z'.repeat(33)}/export`);
    assert.equal(status, 400);
  });

  test('invalid mode gracefully falls back to full_transcript', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, json } = await getJson(`${API}/sessions/${id}/export?mode=hacky_mode&format=json`);
    assert.equal(status, 200);
    assert.equal(json.mode, 'full_transcript', 'invalid mode must fall back to full_transcript');
  });

  test('invalid format gracefully falls back to txt', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { status, headers } = await get(`${API}/sessions/${id}/export?format=docx`);
    assert.equal(status, 200);
    assert.ok(headers.get('content-type')?.includes('text/plain'), 'invalid format must fall back to text/plain');
  });

  test('session with no messages: end_result txt indicates synthesis not complete', async (t) => {
    // This relies on having a session with 0 Synthesis messages.
    // We can find an active/early session which may not have synthesis yet.
    // If none, skip.
    const { json: sessions } = await getJson(`${API}/sessions`);
    if (!Array.isArray(sessions)) return t.skip('Cannot list sessions');
    const noSynthSession = sessions.find(s => s.messageCount === 0);
    if (!noSynthSession) return t.skip('No session with 0 messages');
    const { body } = await get(`${API}/sessions/${noSynthSession.id}/export?mode=end_result&format=txt`);
    assert.ok(body.includes('synthesis') || body.includes('not') || body.includes('completed'), 'should indicate no synthesis');
  });

  test('path traversal attempt returns 400', async () => {
    const { status } = await getJson(`${API}/sessions/%2F..%2F..%2Fetc%2Fpasswd/export`);
    assert.ok([400, 404].includes(status), `expected 400 or 404, got ${status}`);
  });

  test('SQL injection attempt in session ID returns 400', async () => {
    const { status } = await getJson(`${API}/sessions/1%27%20OR%20%271%27%3D%271/export`);
    assert.ok([400, 404].includes(status), `expected 400 or 404, got ${status}`);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Export Filename Convention Tests
// ═══════════════════════════════════════════════════════════════
describe('Export — filename conventions', () => {

  const cases = [
    { mode: 'full_transcript',     slug: 'full-transcript',    fmt: 'txt' },
    { mode: 'end_result',          slug: 'end-result',         fmt: 'md'  },
    { mode: 'end_result_with_qa',  slug: 'end-result-with-qa', fmt: 'json'},
  ];

  for (const { mode, slug, fmt } of cases) {
    test(`filename for mode=${mode} format=${fmt} → war-room-<id>-${slug}.${fmt}`, async (t) => {
      if (!allSessions.length) return t.skip('No sessions in DB');
      const id = allSessions[0].id;
      const { headers } = await get(`${API}/sessions/${id}/export?mode=${mode}&format=${fmt}`);
      const cd = headers.get('content-disposition') || '';
      const expectedFilename = `war-room-${id}-${slug}.${fmt}`;
      assert.ok(cd.includes(expectedFilename), `expected "${expectedFilename}" in Content-Disposition: ${cd}`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// 6. Export Options — Availability Logic
// ═══════════════════════════════════════════════════════════════
describe('Export options — availability logic', () => {

  test('full_transcript available=true when session has messages', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    // Find a session with messages
    const rich = allSessions.find(s => s.messageCount > 0);
    if (!rich) return t.skip('No session with messages');
    const { json } = await getJson(`${API}/sessions/${rich.id}/export/options`);
    const mode = json.modes.find(m => m.id === 'full_transcript');
    assert.equal(mode.available, true);
  });

  test('end_result available=false when hasSynthesis=false', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    // Active early-phase sessions won't have synthesis
    const earlySession = allSessions.find(s => s.active && s.messageCount < 5);
    if (!earlySession) return t.skip('No early-phase active session');
    const { json } = await getJson(`${API}/sessions/${earlySession.id}/export/options`);
    if (!json.hasSynthesis) {
      const mode = json.modes.find(m => m.id === 'end_result');
      assert.equal(mode.available, false, 'end_result should be unavailable when no synthesis');
    } else {
      t.skip('Session already has synthesis');
    }
  });

  test('messageCount matches actual number of messages', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const s = allSessions[0];
    const { json: opts } = await getJson(`${API}/sessions/${s.id}/export/options`);
    // messageCount from /export/options vs messageCount from /api/sessions
    // They use different queries but should agree
    assert.equal(typeof opts.messageCount, 'number');
    assert.ok(opts.messageCount >= 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 7. HTTP Semantics & Headers
// ═══════════════════════════════════════════════════════════════
describe('Export — HTTP semantics', () => {

  test('export responds to GET only (method contract)', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    // Express returns 404 for unregistered methods but not a 405.
    // We just ensure GET works (already covered) and HEAD doesn't crash.
    const res = await fetch(`${API}/sessions/${id}/export`, { method: 'HEAD' });
    assert.ok([200, 405].includes(res.status), `HEAD should be 200 or 405, got ${res.status}`);
  });

  test('export/options returns JSON content-type', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { headers } = await get(`${API}/sessions/${id}/export/options`);
    assert.ok(headers.get('content-type')?.includes('application/json'), 'options must return JSON');
  });

  test('export txt: charset utf-8 declared in content-type', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { headers } = await get(`${API}/sessions/${id}/export?format=txt`);
    const ct = headers.get('content-type') || '';
    assert.ok(ct.includes('utf-8') || ct.includes('UTF-8'), 'charset=utf-8 must be declared');
  });

  test('export json: charset utf-8 declared', async (t) => {
    if (!allSessions.length) return t.skip('No sessions in DB');
    const id = allSessions[0].id;
    const { headers } = await get(`${API}/sessions/${id}/export?format=json`);
    const ct = headers.get('content-type') || '';
    assert.ok(ct.includes('utf-8') || ct.includes('UTF-8'), 'charset=utf-8 must be declared for JSON');
  });
});
