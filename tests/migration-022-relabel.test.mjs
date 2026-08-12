// Migration 022 relabels rows that never reached Synthesis but were stored as
// completions. Without it the incident row stays a lie after the fix ships:
// session 83be7536 (three messages, phase 0 of 5) would keep reading
// `Status: Complete` on every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warroom-mig022-'));
process.env.WAR_ROOM_DB_PATH = path.join(dir, 't.db');
const { db, stmts } = require('./db.js');

const now = Date.now();
function seed(id, phase, active, outcome, messagePhases) {
  db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at, outcome) VALUES (?,?,?,?,?,?,?)')
    .run(id, 'p', phase, active, now, now, outcome);
  (messagePhases || []).forEach((ph, i) => {
    db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id + '-m' + i, id, 'process-architect', 'PA', '', '', 'x', ph, now + i);
  });
}

// The incident shape: stopped inside Framing, stored as a completion.
seed('stopped-as-complete', 0, 0, 'complete', ['Problem Framing', 'Problem Framing']);
// A legacy row from before the outcome column, same shape.
seed('legacy-null', 1, 0, null, ['Problem Framing']);
// Nothing at all: no message, no verdict.
seed('empty-run', 2, 0, null, []);
// A genuine completion must not be touched.
seed('really-complete', 4, 0, 'complete', ['Problem Framing', 'Synthesis']);
// A legacy completion that did reach Synthesis keeps reading as one.
seed('legacy-complete', 4, 0, null, ['Synthesis']);
// An already-labelled row keeps its label.
seed('already-failed', 4, 0, 'failed', []);
// A running room is never relabelled by a migration.
seed('still-running', 1, 1, null, ['Problem Framing']);

// db.js runs every migration at require time, against a DB that was empty, so
// 022 is applied here as SQL over the seeded rows: the statement itself is what
// this test is about.
db.exec(fs.readFileSync(path.join(__dirname, 'migrations', '022_relabel_unfinished_sessions.sql'), 'utf8'));

const get = (id) => db.prepare('SELECT outcome FROM sessions WHERE id = ?').get(id).outcome;

assert.equal(get('stopped-as-complete'), 'stopped', 'a run that never reached Synthesis is stopped');
assert.equal(get('legacy-null'), 'stopped', 'a legacy row with messages but no verdict is stopped');
assert.equal(get('empty-run'), 'failed', 'a run with no message at all is failed');
assert.equal(get('really-complete'), 'complete', 'a genuine completion is untouched');
assert.equal(get('legacy-complete'), null, 'a legacy row that reached Synthesis keeps its NULL');
assert.equal(get('already-failed'), 'failed', 'an already-labelled row keeps its label');
assert.equal(get('still-running'), null, 'a running room is left alone');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('migration-022 assertions passed');
`;

test('migration 022 relabels runs that never produced a verdict', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /migration-022 assertions passed/);
});
