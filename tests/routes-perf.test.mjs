/**
 * F16 — N+1 fix in enrichSession.
 *
 * Spec: forge/hardening/TASKSPEC.md §F16
 *
 * Acceptance:
 *   - getRecentSessions becomes a single SQL with LEFT JOINs and GROUP BY,
 *     returning messageCount + escalationCount inline.
 *   - enrichSession no longer calls countSessionMessages / countSessionEscalations.
 *   - With 50 sessions: hit GET /api/sessions and count db.prepare calls;
 *     total ≤ 2 (one for the SELECT, one for parameter binding).
 *
 * Strategy: spawn a child node script that monkey-patches better-sqlite3's
 * Database.prototype.prepare to count invocations, then requires the routes
 * module and calls the route handler directly. The script reports the call
 * count via stdout JSON.
 *
 * Red phase: enrichSession calls countSessionMessages.get() per row →
 * with 50 sessions you'll see ≥101 prepare calls if you patch at module-init
 * time. Even at handler time you'll see 1 + 50 + 50 = 101 .get() calls
 * against pre-prepared statements; the test counts db.prepare invocations,
 * not .get() calls, so we measure prepare-time only. After F16, the join
 * collapses to a single prepared statement.
 *
 * Per spec constraint, this .test.mjs file does NOT import lib/* directly;
 * the child script does the requires.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runNodeScript, makeTempDir, REPO_ROOT } from './_helpers.mjs';

let temp;
let dbPath;

before(() => {
  temp = makeTempDir('warroom-perf-');
  dbPath = path.join(temp.dir, 'perf.db');

  // Build the schema and seed 50 sessions × 5 messages × 2 escalations.
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  const initialSql = fs.readFileSync(
    path.join(REPO_ROOT, 'migrations', '001_initial.sql'),
    'utf-8'
  );
  db.exec(initialSql);

  const insertSession = db.prepare(
    'INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)'
  );
  const insertMessage = db.prepare(
    'INSERT INTO messages (id, session_id, agent_id, agent_name, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertEscalation = db.prepare(
    "INSERT INTO escalations (id, session_id, agent_id, agent_name, question, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)"
  );

  const seed = db.transaction(() => {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      const sid = 'perf-session-' + i.toString().padStart(3, '0');
      insertSession.run(sid, 'problem ' + i, now - i * 1000, now);
      for (let m = 0; m < 5; m++) {
        insertMessage.run('msg-' + i + '-' + m, sid, 'process-architect', 'PA', 'msg', 'Frame', now);
      }
      for (let e = 0; e < 2; e++) {
        insertEscalation.run('esc-' + i + '-' + e, sid, 'process-architect', 'PA', 'q?', now);
      }
    }
  });
  seed();
  db.close();
});

after(() => {
  temp?.cleanup();
});

describe('F16 — GET /api/sessions: no N+1', () => {
  test('handler invocation makes ≤ 2 db.prepare calls (1 SELECT + 1 binding)', async () => {
    const script = `
      'use strict';
      const Database = require('better-sqlite3');

      // Monkey-patch better-sqlite3 to count prepare() calls BEFORE any
      // module pulls it in via require cache.
      const realPrepare = Database.prototype.prepare;
      let prepareCount = 0;
      let counting = false;
      const prepareLog = [];
      Database.prototype.prepare = function (...args) {
        if (counting) {
          prepareCount += 1;
          prepareLog.push(typeof args[0] === 'string' ? args[0].slice(0, 100) : '<non-string>');
        }
        return realPrepare.apply(this, args);
      };

      // Force db.js to point at the temp DB. db.js currently builds its
      // path from __dirname; in red phase the env var is ignored. We try
      // anyway because S4 will likely add support.
      process.env.WAR_ROOM_DB_PATH = ${JSON.stringify(dbPath)};

      (async () => {
        let routesMod, dbMod;
        try {
          dbMod = require(${JSON.stringify(path.join(REPO_ROOT, 'db.js'))});
          routesMod = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'routes.js'))});
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'require', error: err.message, stack: err.stack }));
          process.exitCode = 1;
          return;
        }

        const handlers = {};
        const fakeApp = {
          use() {},
          get(p, h) { handlers['GET ' + p] = h; },
          post(p, h) { handlers['POST ' + p] = h; },
          put(p, h) { handlers['PUT ' + p] = h; },
          delete(p, h) { handlers['DELETE ' + p] = h; },
        };

        try {
          routesMod.setupRoutes(fakeApp, {
            db: dbMod.db,
            stmts: dbMod.stmts,
            AGENTS: [], PHASES: [],
            activeSessions: new Map(),
            callAnthropic: async () => 'noop',
            createSession: () => ({}),
            loadSession: () => null,
            runDeliberation: async () => {},
            runFollowUp: async () => {},
            broadcast: () => {},
            memory: { storeSessionMemory: async () => {}, extractArchivalFacts: async () => {}, injectMemory: () => '' },
            quality: { evaluateSession: async () => {} },
            specialist: {},
            getAgentsForSession: () => [],
          });
        } catch (err) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'setupRoutes', error: err.message }));
          process.exitCode = 2;
          return;
        }

        const handler = handlers['GET /api/sessions'];
        if (!handler) {
          process.stdout.write(JSON.stringify({ ok: false, stage: 'handler', error: 'GET /api/sessions handler not registered' }));
          process.exitCode = 3;
          return;
        }

        counting = true;
        const fakeReq = { headers: {}, query: {}, params: {} };
        let responseStatus = 200;
        let responseBody = null;
        const fakeRes = {
          status(c) { responseStatus = c; return this; },
          json(b) { responseBody = b; return this; },
          send(b) { responseBody = b; return this; },
        };
        try {
          const result = handler(fakeReq, fakeRes, (err) => { if (err) throw err; });
          if (result && typeof result.then === 'function') {
            await result.catch(() => {});
          }
        } catch (err) {
          counting = false;
          process.stdout.write(JSON.stringify({ ok: false, stage: 'invoke', error: err.message, prepareCount }));
          process.exitCode = 4;
          return;
        }
        counting = false;

        process.stdout.write(JSON.stringify({
          ok: true,
          prepareCount,
          prepareLog,
          responseStatus,
          rowCount: Array.isArray(responseBody) ? responseBody.length : null,
        }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;

    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 20_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.ok(
      parsed.prepareCount <= 2,
      `expected ≤2 db.prepare calls during GET /api/sessions, got ${parsed.prepareCount}.\nQueries:\n${(parsed.prepareLog || []).join('\n')}`
    );
  });

  test('GET /api/sessions returns rows with messageCount and escalationCount inline', async () => {
    // This complements the prepare-count check: confirm the join produces
    // the inline counts the API contract requires.
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
          process.exitCode = 1;
          return;
        }
        const handlers = {};
        const fakeApp = {
          use(){}, get(p,h){handlers['GET '+p]=h}, post(){}, put(){}, delete(){},
        };
        routesMod.setupRoutes(fakeApp, {
          db: dbMod.db, stmts: dbMod.stmts, AGENTS: [], PHASES: [],
          activeSessions: new Map(),
          callAnthropic: async () => '', createSession: () => ({}), loadSession: () => null,
          runDeliberation: async () => {}, runFollowUp: async () => {},
          broadcast: () => {},
          memory: { injectMemory: () => '' }, quality: {}, specialist: {},
          getAgentsForSession: () => [],
        });
        let body = null;
        const handler = handlers['GET /api/sessions'];
        handler({ headers: {}, query: {}, params: {} }, {
          status() { return this; },
          json(b) { body = b; return this; },
        });
        process.stdout.write(JSON.stringify({ ok: true, body }));
      })().catch((err) => {
        process.stdout.write(JSON.stringify({ ok: false, stage: 'unhandled', error: err && err.message }));
        process.exitCode = 9;
      });
    `;
    const { code, stdout, stderr } = await runNodeScript(script, { timeoutMs: 20_000 });
    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch {}

    assert.ok(
      parsed && parsed.ok,
      `runner script failed (code=${code}).\nstdout=${stdout}\nstderr=${stderr}`
    );
    assert.ok(Array.isArray(parsed.body), 'response must be an array');
    assert.ok(parsed.body.length > 0, 'must return at least one session');
    for (const row of parsed.body) {
      assert.ok(typeof row.messageCount === 'number', 'each row must include numeric messageCount');
      assert.ok(typeof row.escalationCount === 'number', 'each row must include numeric escalationCount');
    }
  });
});
