/**
 * Role presets + escalation severity (migration 016).
 *
 * Covers the net-new backend surface for the presets / escalation-UX bundle:
 *   - lib/presets.js config shape and lookup semantics
 *   - migration 016 adds the 5 columns and seeds research-methods
 *   - an escalation row round-trips severity + default_action
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getPreset, listPresets, EXPERIMENTAL_FIELDS } = require(path.join(root, 'lib', 'presets.js'));
const { runMigrations } = require(path.join(root, 'lib', 'migrations.js'));
const Database = require(path.join(root, 'node_modules', 'better-sqlite3'));

test('presets: engineer and scientist have the expected shape', () => {
  const list = listPresets();
  assert.equal(list.length, 2);
  const sci = getPreset('scientist');
  assert.deepEqual(sci.specialists, ['data-science', 'engineering-ml', 'research-methods']);
  assert.deepEqual(sci.synthesis_headers, ['CLAIM', 'METHODS', 'EVIDENCE/CITATIONS', 'LIMITATIONS']);
  const eng = getPreset('engineer');
  assert.deepEqual(eng.synthesis_headers, ['DECISION', 'RATIONALE', 'NEXT ACTIONS', 'RISKS']);
  assert.equal(eng.examples.length, 3);
  // experimental fields are flagged for the n=20 deletion pre-commitment
  assert.ok(EXPERIMENTAL_FIELDS.includes('escalation_tolerance'));
});

test('presets: unknown / null id resolves to Generalist (null), never throws', () => {
  assert.equal(getPreset(null), null);
  assert.equal(getPreset(''), null);
  assert.equal(getPreset('bogus'), null);
});

test('migration 016: adds columns and seeds research-methods specialist', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-mig-')), 'm.db');
  runMigrations({ dbPath, migrationsDir: path.join(root, 'migrations') });
  const db = new Database(dbPath, { readonly: true });
  const ecols = db.prepare('PRAGMA table_info(escalations)').all().map(c => c.name);
  const scols = db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name);
  for (const c of ['severity', 'default_action', 'bulk_resolved']) assert.ok(ecols.includes(c), `escalations.${c}`);
  for (const c of ['preset_id', 'synthesis_quality']) assert.ok(scols.includes(c), `sessions.${c}`);
  const rm = db.prepare("SELECT id, domain FROM agent_templates WHERE domain = 'research-methods'").get();
  assert.equal(rm.id, 'specialist-research-methods');
  db.close();
});

test('escalation row round-trips severity + default_action; defaults to blocking', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wr-esc-')), 'e.db');
  runMigrations({ dbPath, migrationsDir: path.join(root, 'migrations') });
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?,?,0,1,?,?)').run('s1', 'p', now, now);
  const ins = db.prepare("INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, severity, default_action, answer, status, created_at, answered_at) VALUES (?,?,?,?,?,?,?,?,NULL,'pending',?,NULL)");
  ins.run('e1', 's1', 'a', 'A', '🎯', 'Q — [A]/[B] — default: A', 'optional', 'assume A', now);
  // a row inserted without severity falls back to the column default
  db.prepare("INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)").run('e2', 's1', 'a', 'A', '🎯', 'Q2', now);
  const e1 = db.prepare('SELECT severity, default_action, bulk_resolved FROM escalations WHERE id = ?').get('e1');
  const e2 = db.prepare('SELECT severity FROM escalations WHERE id = ?').get('e2');
  assert.equal(e1.severity, 'optional');
  assert.equal(e1.default_action, 'assume A');
  assert.equal(e1.bulk_resolved, 0);
  assert.equal(e2.severity, 'blocking'); // un-classified is never silently optional
  db.close();
});
