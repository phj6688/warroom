// HLB-794 — GET /api/sessions/:id/decision-record returns the verbatim
// Synthesis-phase verdict as JSON with no extra LLM call, and available:false
// for a failed or synthesis-less session. Spawns the real server and seeds the
// temp DB directly (the route reads from the DB, not from activeSessions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnServer } from './_helpers.mjs';

test('decision-record returns the verbatim verdict, available:false for failed/empty (HLB-794)', async () => {
  const server = await spawnServer({ env: {} });
  try {
    const now = Date.now();
    const db = new Database(server.dbPath);
    const insS = db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 4, 0, ?, ?)');
    const insM = db.prepare('INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const setOutcome = db.prepare('UPDATE sessions SET outcome = ?, failed_at = ? WHERE id = ?');

    // A completed session with a synthesis message.
    insS.run('drsynthaaa', 'ship it?', now, now);
    insM.run('m1', 'drsynthaaa', 'process-architect', 'Process Architect', '', '', 'VERDICT: ship the change.', 'Synthesis', now);
    // A session with messages but no synthesis.
    insS.run('drnosynthaa', 'no verdict yet', now, now);
    insM.run('m2', 'drnosynthaa', 'research-scout', 'Research Scout', '', '', 'Some framing.', 'Framing', now);
    // A failed session that (edge case) also has a synthesis row: failed wins.
    insS.run('drfailedaaa', 'stormed out', now, now);
    setOutcome.run('failed', now, 'drfailedaaa');
    insM.run('m3', 'drfailedaaa', 'process-architect', 'Process Architect', '', '', 'should not surface', 'Synthesis', now);
    db.close();

    const get = async (id) => {
      const res = await fetch(`${server.baseUrl}/api/sessions/${id}/decision-record`);
      return { status: res.status, body: await res.json() };
    };

    const synth = await get('drsynthaaa');
    assert.equal(synth.status, 200);
    assert.equal(synth.body.available, true, 'synthesized session has an available record');
    assert.match(synth.body.verdict, /VERDICT: ship the change\./, 'verbatim verdict returned');
    assert.equal(synth.body.outcome, 'complete');

    const noSynth = await get('drnosynthaa');
    assert.equal(noSynth.body.available, false, 'no synthesis -> not available');

    const failed = await get('drfailedaaa');
    assert.equal(failed.body.available, false, 'failed session -> not available');
    assert.equal(failed.body.outcome, 'failed');

    const missing = await fetch(`${server.baseUrl}/api/sessions/doesnotexist99/decision-record`);
    assert.equal(missing.status, 404, 'unknown session -> 404');
  } finally {
    await server.dispose();
  }
});
