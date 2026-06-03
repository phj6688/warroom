/**
 * Session continuation (HLB-147).
 *
 * Seed a NEW session from a chosen PRIOR session's summary, injected as a
 * distinct "CONTINUED FROM PRIOR SESSION" block ahead of the similarity-based
 * "PRIOR SESSIONS" memory block. Covered here:
 *   - both validation schemas accept an optional continuesFromSessionId
 *     (absence is back-compat; non-string is rejected)
 *   - rebuildUserContent renders continuationText before memoryText
 *   - migration 017 adds the nullable link column + its index
 *   - POST /api/sessions forwards continuesFromSessionId into createSession
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { runNodeScript, REPO_ROOT } from './_helpers.mjs';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateWS, httpCreateSessionBody } = require(path.join(root, 'lib', 'validation.js'));
const { rebuildUserContent } = require(path.join(root, 'lib', 'context.js'));
const { runMigrations } = require(path.join(root, 'lib', 'migrations.js'));
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));

describe('validation: continuesFromSessionId', () => {
  test('WS new-session preserves continuesFromSessionId through the gate', () => {
    const ok = validateWS({ type: 'new-session', problem: 'x', continuesFromSessionId: 'abc' });
    assert.equal(ok.ok, true);
    assert.equal(ok.data.continuesFromSessionId, 'abc');
  });

  test('WS new-session without continuesFromSessionId stays valid (back-compat)', () => {
    assert.equal(validateWS({ type: 'new-session', problem: 'x' }).ok, true);
  });

  test('WS new-session rejects a non-string continuesFromSessionId', () => {
    const bad = validateWS({ type: 'new-session', problem: 'x', continuesFromSessionId: 123 });
    assert.equal(bad.ok, false);
  });

  test('httpCreateSessionBody preserves continuesFromSessionId', () => {
    const r = httpCreateSessionBody.safeParse({ problem: 'x', continuesFromSessionId: 'abc' });
    assert.equal(r.success, true);
    assert.equal(r.data.continuesFromSessionId, 'abc');
  });

  test('httpCreateSessionBody without continuesFromSessionId stays valid', () => {
    assert.equal(httpCreateSessionBody.safeParse({ problem: 'x' }).success, true);
  });

  test('httpCreateSessionBody rejects a non-string continuesFromSessionId', () => {
    assert.equal(httpCreateSessionBody.safeParse({ problem: 'x', continuesFromSessionId: 123 }).success, false);
  });
});

describe('context ordering: continuation precedes memory', () => {
  // The continuation block must appear AHEAD of the similarity-based memory
  // block so the council reads "where we left off" before "what looks similar".
  const baseArgs = {
    problem: 'P',
    phaseName: 'Frame',
    agent: { name: 'Process Architect', role: 'Frame', id: 'process-architect' },
    humanMessages: [],
    priorMessageObjs: [],
    answeredEscalationsText: '',
    otherAnswersText: '',
    isFinalSynthesis: false,
    synthesisHeaders: null,
  };

  test('continuationText renders before memoryText', () => {
    const content = rebuildUserContent({ ...baseArgs, continuationText: 'AAA', memoryText: 'BBB' });
    const a = content.indexOf('AAA');
    const b = content.indexOf('BBB');
    assert.ok(a !== -1, 'continuationText present');
    assert.ok(b !== -1, 'memoryText present');
    assert.ok(a < b, `continuation (${a}) must precede memory (${b})`);
  });

  test('continuationText alone renders without memory', () => {
    const content = rebuildUserContent({ ...baseArgs, continuationText: 'AAA', memoryText: '' });
    assert.ok(content.includes('AAA'));
  });

  test('omitting continuationText leaves a control session unchanged', () => {
    const content = rebuildUserContent({ ...baseArgs, memoryText: 'BBB' });
    assert.ok(!content.includes('AAA'));
    assert.ok(content.includes('BBB'));
  });
});

describe('migration 017: session continuation link', () => {
  test('adds nullable continues_from_session_id column + index', () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cont-')), 'c.db');
    runMigrations({ dbPath, migrationsDir: path.join(root, 'migrations') });
    const db = new Database(dbPath);
    const cols = db.prepare('PRAGMA table_info(sessions)').all();
    const col = cols.find(c => c.name === 'continues_from_session_id');
    assert.ok(col, 'continues_from_session_id column exists');
    assert.equal(col.notnull, 0, 'column is nullable');
    assert.equal(col.dflt_value, null, 'column has no default');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_continues_from'").get();
    assert.ok(idx, 'idx_sessions_continues_from index exists');
    // round-trip: a continued row carries the link, a control row stays NULL
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?,?,0,1,?,?)').run('src', 'p', now, now);
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?,?,0,1,?,?)').run('cont', 'p2', now, now);
    db.prepare('UPDATE sessions SET continues_from_session_id = ?, updated_at = ? WHERE id = ?').run('src', now, 'cont');
    assert.equal(db.prepare('SELECT continues_from_session_id AS c FROM sessions WHERE id = ?').get('cont').c, 'src');
    assert.equal(db.prepare('SELECT continues_from_session_id AS c FROM sessions WHERE id = ?').get('src').c, null);
    db.close();
  });
});

describe('route forwarding: POST /api/sessions', () => {
  // Per repo convention this .test.mjs does not import lib/* directly; a child
  // script wires a fake app and a stubbed createSession that records its args.
  test('forwards continuesFromSessionId as the 4th createSession arg', async () => {
    const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-fwd-')), 'f.db');
    const script = `
      'use strict';
      process.env.WAR_ROOM_DB_PATH = ${JSON.stringify(dbPath)};
      (async () => {
        let dbMod, routesMod;
        try {
          dbMod = require(${JSON.stringify(path.join(REPO_ROOT, 'db.js'))});
          routesMod = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'routes.js'))});
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message }));
          process.exitCode = 1; return;
        }
        const handlers = {};
        const fakeApp = { use(){}, get(){}, put(){}, delete(){}, post(p, ...rest){ handlers['POST '+p] = rest[rest.length-1]; } };
        let captured = null;
        routesMod.setupRoutes(fakeApp, {
          db: dbMod.db, stmts: dbMod.stmts, AGENTS: [], PHASES: [],
          activeSessions: new Map(),
          callAnthropic: async () => '',
          createSession: async (problem, fileIds, presetId, continuesFromSessionId) => {
            captured = { problem, fileIds, presetId, continuesFromSessionId };
            return { id: 's-new', problem, phase: 0, active: true, createdAt: Date.now() };
          },
          loadSession: () => null,
          runDeliberation: async () => {},
          runFollowUp: async () => {},
          broadcast: () => {},
          memory: { storeSessionMemory: async () => {}, injectMemory: () => '' },
          quality: {}, specialist: {},
          getAgentsForSession: () => [],
        });
        const handler = handlers['POST /api/sessions'];
        if (!handler) { process.stdout.write(JSON.stringify({ ok:false, stage:'handler' })); process.exitCode = 3; return; }
        // validateBody middleware runs ahead of the handler; the handler here is
        // the terminal fn, so feed it a body the schema already accepted.
        const req = { headers:{}, query:{}, params:{}, body: { problem:'hello', continuesFromSessionId:'prior-1' }, log:{ error(){} } };
        const res = { status(){ return this; }, json(){ return this; } };
        await handler(req, res, (e)=>{ if(e) throw e; });
        process.stdout.write(JSON.stringify({ ok: true, captured }));
      })().catch(err => { process.stdout.write(JSON.stringify({ ok:false, stage:'unhandled', error: err && err.message })); process.exitCode = 9; });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 20_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}
    assert.ok(parsed && parsed.ok, `runner failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`);
    assert.ok(parsed.captured, 'createSession was called');
    assert.equal(parsed.captured.continuesFromSessionId, 'prior-1');
  });
});
