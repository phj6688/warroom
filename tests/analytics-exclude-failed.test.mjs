// HLB-880 — getAnalytics must exclude sessions with no Synthesis message so the
// quality average reflects genuine deliberations, not the historical
// failed/empty sessions that were scored before B7 (HLB-797). Driven via a
// child script against the real db.js + createQualityManager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-ana-'));
process.env.WAR_ROOM_DB_PATH = path.join(dir, 't.db');
const { db, stmts } = require('./db.js');            // runs migrations
const { createQualityManager } = require('./lib/quality.js');

const now = Date.now();
// A: a genuine deliberation (has a Synthesis message) scored 0.9.
stmts.insertSession.run('anareal0001', 'p', now, now);
stmts.updateSessionActive.run(0, now, 'anareal0001');
stmts.insertMessage.run('am1', 'anareal0001', 'process-architect', 'PA', '', '', 'verdict', 'Synthesis', now);
stmts.insertQualityScore.run('qa1', 'anareal0001', 0.9, 1, 0.9, 0, null, 0.9, 'test', now);
// B: a synthesis-less session (the pre-B7 failed/empty pattern) with a 0.2 score row.
stmts.insertSession.run('anafail0001', 'p', now, now);
stmts.updateSessionActive.run(0, now, 'anafail0001');
stmts.insertQualityScore.run('qb1', 'anafail0001', 0, 1, 0, 0, null, 0.2, 'test', now + 1);

const quality = createQualityManager({ db, stmts, callAnthropic: async () => '', PHASES: [], onTokenUsage: () => {} });
const a = quality.getAnalytics();
assert.equal(a.count, 1, 'only the synthesized session is counted, got ' + a.count);
assert.ok(Math.abs(a.avg - 0.9) < 1e-9, 'avg reflects only the real deliberation (0.9), got ' + a.avg);
assert.ok(a.topSessions.every(s => s.session_id !== 'anafail0001'), 'failed session excluded from topSessions');
assert.ok(a.bottomSessions.every(s => s.session_id !== 'anafail0001'), 'failed session excluded from bottomSessions');
console.log('analytics-exclude-failed assertions passed');
`;

test('getAnalytics excludes synthesis-less (failed/empty) sessions from the average (HLB-880)', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /analytics-exclude-failed assertions passed/);
});
