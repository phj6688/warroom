// A caller polling a running room had one question — what phase is it in, is
// anything waiting on me — and one tool that answered it: warroom_get_session,
// which returned the whole transcript every time. warroom_get_status only
// aggregates across sessions, so the poll cost grew with the deliberation it
// was watching. The detail view is now a status read by default, the transcript
// is opt-in, and warroom_get_messages takes a cursor so a second poll reads
// only what arrived since the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnServer, REPO_ROOT } from './_helpers.mjs';

const mcpKey = 'test-mcp-key-session-poll';
const SID = 'pollsess0001';

// Two phases, three agents, one long message each, so a full transcript is
// unmistakably larger than a status read.
const BODY = 'x'.repeat(400);
// A real problem statement runs to thousands of characters, and an answered
// escalation carries the caller's own long answer. Both used to ride along on
// every poll.
const PROBLEM = `should we rewrite the router ${'p'.repeat(900)}`;
const ANSWER = `yes, two weeks ${'a'.repeat(900)}`;

function seed(dbPath) {
  const db = new Database(dbPath);
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
    .run(SID, PROBLEM, now, now);
  const ins = db.prepare(`INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at)
                          VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`);
  const rows = [
    ['m1', 'process-architect', 'Process Architect', '', 'Problem Framing'],
    ['m2', 'research-scout', 'Research Scout', '', 'Problem Framing'],
    ['m3', 'process-architect', 'Process Architect', '', 'Divergence'],
    ['m4', 'research-scout', 'Research Scout', '', 'Divergence'],
    ['m5', 'red-teamer', 'Red Teamer', '', 'Divergence'],
  ];
  rows.forEach(([id, agentId, name, emoji, phase], i) => {
    ins.run(id, SID, agentId, name, emoji, `${id} ${BODY}`, phase, now + i);
  });
  db.prepare(`INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, status, created_at)
              VALUES (?, ?, ?, ?, '', ?, 'pending', ?)`)
    .run('esc1', SID, 'red-teamer', 'Red Teamer', 'Do we have a rollback budget?', now + 10);
  db.prepare(`INSERT INTO escalations (id, session_id, agent_id, agent_name, agent_emoji, question, answer, status, created_at, answered_at)
              VALUES (?, ?, ?, ?, '', ?, ?, 'answered', ?, ?)`)
    .run('esc2', SID, 'research-scout', 'Research Scout', 'How long may the migration take?', ANSWER, now + 12, now + 13);
  db.prepare('INSERT INTO human_messages (id, session_id, content, created_at) VALUES (?, ?, ?, ?)')
    .run('h1', SID, 'keep it under two weeks', now + 11);
  db.close();
}

function textOf(res) {
  return (res.content || []).map(c => c.text || '').join('\n');
}

// The renderer prints the cursor as `Cursor: N`; a poller reads it back out.
function cursorOf(text) {
  const m = text.match(/Cursor:\s*(\d+)/);
  assert.ok(m, `no cursor in output:\n${text}`);
  return Number(m[1]);
}

async function assertPollContract(call) {
  // 1. Default detail is a status read: no transcript, but every line a poller
  //    actually polls for.
  const light = textOf(await call('warroom_get_session', { sessionId: SID }));
  assert.match(light, /Status: Running/, 'status survives the trim');
  assert.match(light, /Phase: /, 'phase survives the trim');
  assert.match(light, /Do we have a rollback budget\?/, 'escalations survive the trim');
  assert.doesNotMatch(light, new RegExp(BODY), 'the transcript must not be in the default read');
  assert.match(light, /Messages: 5/, 'the message count stands in for the transcript');
  assert.match(light, /Escalations \(2 total, 1 pending\)/, 'the poll says how many still want an answer');
  // A pending escalation is the reason to poll, so it arrives whole. An
  // answered one is the caller's own text and only its verdict is worth
  // repeating.
  assert.doesNotMatch(light, new RegExp(ANSWER), 'an answered escalation must not repeat its body on every poll');
  // Listing every answered escalation would grow the poll with the room's own
  // history. The header count carries them instead.
  assert.doesNotMatch(light, /How long may the migration take/, 'nor its question');
  assert.match(light, /1 answered escalation\(s\) omitted/, 'but the poll says they exist');
  assert.doesNotMatch(light, new RegExp('p'.repeat(400)), 'a long problem statement is trimmed for the poll');
  assert.match(light, /Problem: should we rewrite the router/, 'enough of it survives to identify the room');
  assert.ok(light.length < 1500, `a status read must stay small, got ${light.length} chars`);

  // 2. The trimmed view still tells the caller where to pick the log up.
  assert.equal(cursorOf(light), 5, 'the detail view hands back a cursor');

  // 3. Opt in and the transcript comes back.
  const full = textOf(await call('warroom_get_session', { sessionId: SID, includeMessages: true }));
  assert.match(full, new RegExp(`m1 ${BODY}`), 'includeMessages returns the transcript');
  assert.match(full, /keep it under two weeks/, 'and the human interjections');
  assert.match(full, new RegExp(ANSWER), 'and the answered escalation in full');
  assert.match(full, new RegExp('p'.repeat(400)), 'and the whole problem statement');
  assert.match(full, /Status: Running/, 'without losing the status header');

  // 4. A cursor read returns only what landed after it.
  const tail = textOf(await call('warroom_get_messages', { sessionId: SID, since: 3 }));
  assert.match(tail, /m4/, 'messages after the cursor are returned');
  assert.match(tail, /m5/);
  assert.doesNotMatch(tail, /m1 /, 'messages at or before the cursor are not');
  assert.doesNotMatch(tail, /m3 /);
  assert.equal(cursorOf(tail), 5, 'the cursor advances to the end of the log');

  // 5. A cursor at the head of the log returns nothing but still advances, so
  //    an idle poll does not re-read the same messages forever.
  const caughtUp = textOf(await call('warroom_get_messages', { sessionId: SID, since: 5 }));
  assert.doesNotMatch(caughtUp, new RegExp(BODY), 'nothing new means nothing returned');
  assert.equal(cursorOf(caughtUp), 5, 'and the cursor holds');

  // 6. limit pages the log; the returned cursor resumes exactly where it left.
  const page1 = textOf(await call('warroom_get_messages', { sessionId: SID, limit: 2 }));
  assert.match(page1, /m1/);
  assert.match(page1, /m2/);
  assert.doesNotMatch(page1, /m3/, 'limit caps the page');
  assert.match(page1, /more/i, 'a truncated page says more remain');
  const page2 = textOf(await call('warroom_get_messages', { sessionId: SID, since: cursorOf(page1), limit: 2 }));
  assert.match(page2, /m3/, 'the next page resumes at the cursor');
  assert.doesNotMatch(page2, /m2 /, 'and does not repeat the last page');

  // 7. The cursor is a session-level watermark, so adding a filter does not
  //    change what a given cursor means.
  const filtered = textOf(await call('warroom_get_messages', { sessionId: SID, since: 2, phase: 'Divergence' }));
  assert.match(filtered, /m3/);
  assert.match(filtered, /m5/);
  assert.doesNotMatch(filtered, /m1 /, 'the phase filter still applies');
}

// A stamp outside Date's range is still a finite number, so `new Date(n)`
// accepts it and `toISOString()` throws. A row written in nanoseconds rather
// than milliseconds would then take the whole status line down with it — the
// one line a poller depends on.
test('a message stamp outside Date range costs one detail, not the status line', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: `${mcpKey}-clock` } });
  try {
    const db = new Database(server.dbPath);
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, problem, phase, active, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
      .run('badclock001', 'stamped in nanoseconds', now, now);
    db.prepare(`INSERT INTO messages (id, session_id, agent_id, agent_name, agent_emoji, agent_color, content, phase, created_at)
                VALUES ('bc1', 'badclock001', 'red-teamer', 'Red Teamer', '', '', 'said something', 'Divergence', ?)`)
      .run(now * 1e6);
    db.close();

    const client = new Client({ name: 'session-poll-clock-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${mcpKey}-clock`)));
    try {
      const res = await client.callTool({ name: 'warroom_get_session', arguments: { sessionId: 'badclock001' } });
      const text = textOf(res);
      assert.notEqual(res.isError, true, text);
      assert.match(text, /Status: Running/, 'the status line survives a bad stamp');
      assert.match(text, /Messages: 1/, 'and so does the count');
      assert.match(text, /latest: Red Teamer \[Divergence\]/, 'who spoke last is still named');
      assert.doesNotMatch(text, /1970-01-01/, 'a missing or unusable stamp is omitted, not dated to the epoch');
    } finally {
      await client.close();
    }
  } finally {
    await server.dispose();
  }
});

test('HTTP transport: session detail polls cheap and messages take a cursor', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '', MCP_API_KEY: mcpKey } });
  try {
    seed(server.dbPath);
    const client = new Client({ name: 'session-poll-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${mcpKey}`)));
    try {
      await assertPollContract((name, args) => client.callTool({ name, arguments: args }));
    } finally {
      await client.close();
    }
  } finally {
    await server.dispose();
  }
});

test('stdio transport: the same contract over REST', async () => {
  const server = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
  const client = new Client({ name: 'session-poll-stdio-test', version: '1.0.0' });
  try {
    seed(server.dbPath);
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'mcp', 'stdio.mjs')],
      env: { ...process.env, WAR_ROOM_URL: server.baseUrl, WAR_ROOM_TOKEN: '' },
    }));
    await assertPollContract((name, args) => client.callTool({ name, arguments: args }));
  } finally {
    await client.close().catch(() => {});
    await server.dispose();
  }
});
