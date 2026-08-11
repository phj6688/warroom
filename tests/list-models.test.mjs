// GET /api/settings/models — the Settings panel's model catalog. A stub
// OpenAI-compatible gateway answers GET /models so assertions don't depend on
// a live provider. Provider failures must come back as 200 { ok:false, error }
// (data, not an endpoint error); only an unknown route id 400s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnServer, getFreePort } from './_helpers.mjs';

let stub, stubPort, server;

before(async () => {
  stubPort = await getFreePort();
  stub = createServer((req, res) => {
    if (req.url === '/broken/models') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'gateway exploded' } }));
      return;
    }
    if (req.url === '/v1/models') {
      // Unsorted, with a duplicate and a junk entry: the endpoint promises a
      // sorted, deduped list of string ids.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [
        { id: 'gpt-5.5' }, { id: 'claude-opus-5' }, { id: 'gpt-5.5' }, { id: 42 }, {},
        { id: 'anthropic/claude-haiku-4-5' },
      ] }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

  server = await spawnServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENAI_API_KEY: 'stub-key',
      MODEL: 'good-model',
      OLLAMA_BASE_URL: `http://127.0.0.1:${stubPort}/broken`,
      OPENROUTER_API_KEY: '',
    },
  });
});

after(async () => {
  await server?.dispose();
  await new Promise((r) => stub.close(r));
});

const list = (qs = '') => fetch(`${server.baseUrl}/api/settings/models${qs}`);

test('default route lists the gateway catalog, sorted and deduped', async () => {
  const res = await list();
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, true);
  assert.equal(r.route, 'default');
  assert.deepEqual(r.models, ['anthropic/claude-haiku-4-5', 'claude-opus-5', 'gpt-5.5']);
});

test('provider failure is data, not an endpoint error', async () => {
  const res = await list('?route=ollama-local');
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, false);
  assert.equal(r.route, 'ollama-local');
  assert.deepEqual(r.models, []);
  assert.match(r.error, /Gateway error \(500\)/);
});

test('route without configured credentials fails as data', async () => {
  const res = await list('?route=openrouter');
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, false);
  assert.match(r.error, /no credentials/i);
});

test('unknown route is a 400', async () => {
  const res = await list('?route=bogus');
  assert.equal(res.status, 400);
  const r = await res.json();
  assert.match(r.error, /unknown route/);
});
