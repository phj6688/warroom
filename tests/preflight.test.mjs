// Preflight dry run — POST /api/settings/preflight and the gate on
// PUT /api/settings/agent-routing.
//
// A stub OpenAI-compatible gateway decides which model ids answer, so the
// assertions never depend on a live provider. It also records whether a request
// carried a tools array, which is how the "every agent turn ships tools" probe
// is proven rather than assumed.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { spawnServer, getFreePort } from './_helpers.mjs';

let stub, stubPort, server;
let seen = [];

// Only these ids answer. Anything else is the provider saying "no such model",
// which is exactly the typo the dry run exists to catch before it is stored.
const GOOD = new Set(['good-model', 'other-good-model']);
const MCP_KEY = 'preflight-test-mcp-key-0001';

before(async () => {
  stubPort = await getFreePort();
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [...GOOD].map(id => ({ id })) }));
        return;
      }
      const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
      seen.push({ model: parsed.model, tools: Array.isArray(parsed.tools) ? parsed.tools.length : 0 });
      if (req.url.endsWith('/chat/completions') && GOOD.has(parsed.model)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `model ${parsed.model} not found` } }));
    });
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

  server = await spawnServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENAI_API_KEY: 'stub-key',
      MODEL: 'good-model',
      OPENROUTER_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      MCP_API_KEY: MCP_KEY,
      WAR_ROOM_TOKEN: '',
    },
  });
});

after(async () => {
  await server?.dispose();
  await new Promise((r) => stub.close(r));
});

beforeEach(() => { seen = []; });

const preflight = (body = {}) => fetch(`${server.baseUrl}/api/settings/preflight`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const putRouting = (body) => fetch(`${server.baseUrl}/api/settings/agent-routing`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const getRouting = async () => (await fetch(`${server.baseUrl}/api/settings/agent-routing`)).json();

test('a live configuration on a reachable model passes every phase', async () => {
  const r = await (await preflight()).json();
  assert.equal(r.ok, true, r.summary);
  assert.equal(r.phases.length, 5);
  assert.ok(r.phases.every(p => p.ok));
  assert.ok(r.support.length >= 5, 'support calls around the phases are checked too');
  assert.ok(r.support.every(s => s.ok));
  assert.deepEqual(r.failures, []);
});

test('one probe per distinct pair, not one per agent', async () => {
  const r = await (await preflight()).json();
  // Every checkpoint resolves to the same model, so the walk costs two probes:
  // the tools kind for agent turns and the chat kind for the support calls.
  assert.equal(r.probeCount, 2);
  assert.ok(r.checkpointCount > 10, 'many checkpoints collapse onto few probes');
  assert.equal(seen.length, 2);
  assert.equal(seen.filter(s => s.tools > 0).length, 1, 'agent turns are probed with a tools array');
  assert.equal(seen.filter(s => s.tools === 0).length, 1, 'support calls are probed without one');
});

test('a candidate model the provider rejects fails the dry run and names the phase', async () => {
  const r = await (await preflight({ routing: { 'red-teamer': { model: 'typo-model' } } })).json();
  assert.equal(r.ok, false);
  assert.ok(r.failures.length > 0);
  assert.ok(r.failures.some(f => /Red Team/.test(f) && /typo-model/.test(f)), r.failures.join(' | '));
  const redTeam = r.phases.find(p => p.name === 'Red Team');
  assert.equal(redTeam.ok, false);
  assert.equal(redTeam.agents.find(a => a.id === 'red-teamer').ok, false);
  // The same agent speaks in one phase only here, so the other phases stay green.
  assert.equal(r.phases.find(p => p.name === 'Divergence').ok, true);
});

test('the dry run checks a candidate without persisting it', async () => {
  await preflight({ routing: { 'red-teamer': { model: 'typo-model' } } });
  const cfg = await getRouting();
  assert.equal(cfg.routing['red-teamer'], undefined, 'nothing was stored');
});

test('PUT refuses a candidate that fails the dry run and keeps the old config', async () => {
  const before = await getRouting();
  const res = await putRouting({ routing: { 'red-teamer': { model: 'typo-model' } } });
  assert.equal(res.status, 409);
  const payload = await res.json();
  assert.equal(payload.error, 'preflight_failed');
  assert.equal(payload.preflight.ok, false);
  assert.ok(payload.preflight.failures.length > 0);
  const after = await getRouting();
  assert.deepEqual(after.routing, before.routing, 'the rejected candidate was not stored');
});

test('force stores a failing candidate and says so', async () => {
  const res = await putRouting({ routing: { 'red-teamer': { model: 'typo-model' } }, force: true });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.forced, true);
  assert.equal(payload.preflight.ok, false);
  const cfg = await getRouting();
  assert.equal(cfg.routing['red-teamer'].model, 'typo-model');
  // Put it back so the remaining tests start from a clean map.
  await putRouting({ routing: {} });
});

test('a passing candidate is stored and the report rides along', async () => {
  const res = await putRouting({ routing: { 'red-teamer': { model: 'other-good-model' } } });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.preflight.ok, true);
  assert.equal(payload.forced, false);
  // Two distinct agent-turn models now, so the probe count grows by one.
  assert.equal(payload.preflight.probeCount, 3);
  const cfg = await getRouting();
  assert.equal(cfg.routing['red-teamer'].model, 'other-good-model');
  await putRouting({ routing: {} });
});

test('a write that changes nothing skips the dry run', async () => {
  seen = [];
  const res = await putRouting({ routing: {} });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.preflightSkipped, 'unchanged');
  assert.equal(payload.preflight, null);
  assert.equal(seen.length, 0, 'no provider call was made');
});

test('skipPreflight stores without probing', async () => {
  seen = [];
  const res = await putRouting({ routing: { 'red-teamer': { model: 'typo-model' } }, skipPreflight: true });
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.preflightSkipped, 'requested');
  assert.equal(seen.length, 0);
  await putRouting({ routing: {}, skipPreflight: true });
});

test('a stored route with no model names that cause, not a missing credential', async () => {
  // The PUT rejects a route-only entry, so this shape only reaches the dry run
  // from a row that predates that check or was hand-edited. ollama-local always
  // has credentials, so the fallback here can only be the missing model — and
  // the two causes need different fixes, so they need different messages.
  // Written straight into app_settings, then re-read by a fresh server.
  const db = new Database(server.dbPath);
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run('agent_routing', JSON.stringify({ 'red-teamer': { route: 'ollama-local' } }), Date.now());
  db.close();

  const hand = await spawnServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENAI_API_KEY: 'stub-key',
      MODEL: 'good-model',
      WAR_ROOM_DB_PATH: server.dbPath,
      WAR_ROOM_TOKEN: '',
    },
  });
  try {
    const r = await (await fetch(`${hand.baseUrl}/api/settings/preflight`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    const row = r.phases.find(p => p.name === 'Red Team').agents.find(a => a.id === 'red-teamer');
    assert.equal(row.ok, false, 'a route that does not take is a failure');
    assert.equal(row.fellBack, true);
    assert.match(row.error, /no model id/, `must name the real cause, got: ${row.error}`);
    assert.doesNotMatch(row.error, /no credentials/, 'and must not blame the credential');
  } finally {
    await hand.dispose();
    const cleanup = new Database(server.dbPath);
    cleanup.prepare('DELETE FROM app_settings WHERE key = ?').run('agent_routing');
    cleanup.close();
  }
});

test('a route with no credentials is a failure, not a silent fallback', async () => {
  // openrouter has no key in this deployment, so resolveRoute would quietly
  // hand the agent back to the default provider. The dry run must say so.
  const r = await (await preflight({ routing: { 'red-teamer': { route: 'openrouter', model: 'good-model' } } })).json();
  assert.equal(r.ok, false);
  const row = r.phases.find(p => p.name === 'Red Team').agents.find(a => a.id === 'red-teamer');
  assert.equal(row.ok, false);
  assert.equal(row.fellBack, true);
  assert.match(row.error, /openrouter/);
});

// ─── MCP surface ────────────────────────────────────────────────────────
// The MCP client must learn about the dry run the same way the panel does:
// a blocked write says so and names what failed, and the report never gets
// so long that it drowns the answer.

test('warroom_set_model is blocked by a failing dry run, and force gets past it', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'preflight-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/mcp?key=${MCP_KEY}`)));
  try {
    const textOf = (r) => (r.content || []).map(c => c.text || '').join('\n');

    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('warroom_preflight'), 'the dry run has its own tool');

    const blocked = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'typo-model' } });
    assert.equal(blocked.isError, true, 'a blocked write is an error the client must act on');
    const msg = textOf(blocked);
    assert.match(msg, /NOT SAVED/);
    assert.match(msg, /DRY RUN FAILED/);
    assert.match(msg, /typo-model/);
    assert.ok(msg.length < 4000, `report stays readable, got ${msg.length} chars`);
    const cfg = await getRouting();
    assert.equal(cfg.routing['red-teamer'], undefined, 'nothing was stored');

    const forced = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'typo-model', force: true } });
    assert.notEqual(forced.isError, true);
    assert.match(textOf(forced), /SAVED WITH force/);
    assert.equal((await getRouting()).routing['red-teamer'].model, 'typo-model');

    // A passing write reports the passing dry run rather than staying silent.
    const okSet = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'other-good-model' } });
    assert.notEqual(okSet.isError, true, textOf(okSet));
    assert.match(textOf(okSet), /DRY RUN PASSED/);

    // The standalone tool checks a candidate without saving it.
    const probe = await client.callTool({ name: 'warroom_preflight', arguments: { agentId: 'red-teamer', model: 'typo-model' } });
    assert.match(textOf(probe), /candidate configuration \(not saved\)/);
    assert.match(textOf(probe), /DRY RUN FAILED/);
    assert.equal((await getRouting()).routing['red-teamer'].model, 'other-good-model', 'the candidate check changed nothing');

    const live = await client.callTool({ name: 'warroom_preflight', arguments: {} });
    assert.match(textOf(live), /live configuration/);
    assert.match(textOf(live), /DRY RUN PASSED/);

    // A typo used to be dropped server-side, so the dry run checked the live
    // configuration and reported a pass for a candidate nobody tested.
    const typoAgent = await client.callTool({ name: 'warroom_preflight', arguments: { agentId: 'not-an-agent', model: 'typo-model' } });
    assert.equal(typoAgent.isError, true);
    assert.match(textOf(typoAgent), /unknown agent: not-an-agent/);

    // Setting the same pair twice must not probe again: an idempotent call
    // would otherwise be blocked whenever the provider is briefly down.
    // "Model updated" alone would also pass if the probe ran, so count the
    // stub's requests instead of reading the wording.
    const probesBefore = seen.length;
    const again = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'other-good-model' } });
    assert.notEqual(again.isError, true, textOf(again));
    assert.equal(seen.length, probesBefore, 'an unchanged write must make no provider call');
  } finally {
    await client.close();
    await putRouting({ routing: {}, skipPreflight: true });
  }
});

test('the stdio transport surfaces a blocked write as the report, not HTTP 409', async () => {
  // apiSend rejects on every non-2xx, so the refusal has to be caught rather
  // than read off a returned body. Missing that, a blocked save reached the
  // client as "HTTP 409: {blob}" and the whole point of the gate was lost on
  // the transport Claude Code actually uses.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const path = await import('node:path');
  const { REPO_ROOT } = await import('./_helpers.mjs');

  const client = new Client({ name: 'preflight-stdio-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO_ROOT, 'mcp', 'stdio.mjs')],
    env: { ...process.env, WAR_ROOM_URL: server.baseUrl, WAR_ROOM_TOKEN: '' },
  }));
  try {
    const textOf = (r) => (r.content || []).map(c => c.text || '').join('\n');

    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes('warroom_preflight'), 'stdio advertises the dry-run tool too');

    const blocked = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'typo-model' } });
    assert.equal(blocked.isError, true);
    const msg = textOf(blocked);
    assert.match(msg, /NOT SAVED/, `expected the report, got: ${msg.slice(0, 200)}`);
    assert.match(msg, /DRY RUN FAILED/);
    assert.doesNotMatch(msg, /^HTTP 409/, 'a raw transport error tells the caller nothing actionable');
    assert.equal((await getRouting()).routing['red-teamer'], undefined, 'nothing was stored');

    const passed = await client.callTool({ name: 'warroom_set_model', arguments: { agentId: 'red-teamer', model: 'other-good-model' } });
    assert.notEqual(passed.isError, true, textOf(passed));
    assert.match(textOf(passed), /DRY RUN PASSED/);

    assert.match(textOf(await client.callTool({ name: 'warroom_preflight', arguments: {} })), /DRY RUN PASSED/);
  } finally {
    await client.close();
    await putRouting({ routing: {}, skipPreflight: true });
  }
});
