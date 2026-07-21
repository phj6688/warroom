// B7 (HLB-797) — a failed run must not be scored as quality, NOT EVEN by the
// boot-time retroactive backfill. Skipping the completion-path enqueue is
// necessary but not sufficient: retroactiveScore() would re-select the failed
// session (active=0, no quality_scores row) and score it on the next boot. This
// asserts both the backfill query and a direct evaluateSession skip a failed
// session. Driven via a child script (no in-process lib import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-b7retro-'));
process.env.WAR_ROOM_DB_PATH = path.join(dir, 't.db');
const { db, stmts } = require('./db.js');            // runs migrations incl. 021
const { createQualityManager } = require('./lib/quality.js');

const now = Date.now();
// A failed session: active=0, outcome='failed', zero messages, no quality_scores.
stmts.insertSession.run('failed-1', 'p', now, now);   // stmt hardcodes active=1
stmts.updateSessionActive.run(0, now, 'failed-1');
stmts.updateSessionOutcome.run('failed', now, now, 'failed-1');

const quality = createQualityManager({ db, stmts, callAnthropic: async () => '', PHASES: [], onTokenUsage: () => {} });

(async () => {
  const res = await quality.retroactiveScore();
  assert.ok(!db.prepare('SELECT 1 FROM quality_scores WHERE session_id = ?').get('failed-1'),
    'retroactiveScore must NOT create a quality_scores row for a failed session');
  const sess = stmts.getSession.get('failed-1');
  assert.ok(sess.quality_score == null, 'failed session has no quality_score after backfill');

  // Defense-in-depth: a direct evaluateSession on a failed session is a no-op.
  const direct = await quality.evaluateSession('failed-1');
  assert.equal(direct, null, 'evaluateSession returns null for a failed session');
  assert.ok(!db.prepare('SELECT 1 FROM quality_scores WHERE session_id = ?').get('failed-1'),
    'still no quality_scores row after a direct evaluateSession');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('b7-retroactive assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('failed sessions are never scored, including by the retroactive backfill (HLB-797)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /b7-retroactive assertions passed/);
});
