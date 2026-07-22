// POST /api/settings/test-connection — the Settings panel's connection probe.
// A stub OpenAI-compatible gateway answers /chat/completions so assertions
// don't depend on a live provider: 200 for "good-model", a 404 body otherwise.
// Provider failures must come back as 200 { ok:false, error } (data, not an
// endpoint error); only invalid request shapes 400.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnServer, getFreePort } from './_helpers.mjs';

let stub, stubPort, server;

before(async () => {
  stubPort = await getFreePort();
  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const model = (() => { try { return JSON.parse(body).model; } catch { return null; } })();
      if (req.url.endsWith('/chat/completions') && model === 'good-model') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `model ${model} not found` } }));
      }
    });
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));

  server = await spawnServer({
    env: {
      OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENAI_API_KEY: 'stub-key',
      MODEL: 'good-model',
      OLLAMA_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      OPENROUTER_API_KEY: '',
    },
  });
});

after(async () => {
  await server?.dispose();
  await new Promise((r) => stub.close(r));
});

const probe = (body) => fetch(`${server.baseUrl}/api/settings/test-connection`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('empty body tests the deployment default end to end', async () => {
  const res = await probe({});
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, true);
  assert.equal(r.route, 'default');
  assert.equal(r.model, 'good-model');
  assert.equal(typeof r.latencyMs, 'number');
});

test('explicit model on the default route overrides the env model', async () => {
  const res = await probe({ model: 'bad-model' });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, false);
  assert.equal(r.model, 'bad-model');
  assert.match(r.error, /Gateway error \(404\)/);
  assert.match(r.error, /bad-model not found/);
});

test('explicit route with credentials works (ollama-local via stub)', async () => {
  const res = await probe({ route: 'ollama-local', model: 'good-model' });
  const r = await res.json();
  assert.equal(r.ok, true);
  assert.equal(r.route, 'ollama-local');
});

test('route without configured credentials fails as data, not 500', async () => {
  const res = await probe({ route: 'openrouter', model: 'x' });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.ok, false);
  assert.match(r.error, /no credentials|route has no credentials/i);
});

test('unknown route is rejected by validation', async () => {
  const res = await probe({ route: 'bogus', model: 'x' });
  assert.equal(res.status, 400);
  const r = await res.json();
  assert.equal(r.error, 'validation_failed');
});

test('non-default route without a model is a 400, mirroring the save rule', async () => {
  const res = await probe({ route: 'ollama-local' });
  assert.equal(res.status, 400);
  const r = await res.json();
  assert.match(r.error, /requires an explicit model/);
});

test('error bodies are capped so a verbose gateway cannot flood the panel', async () => {
  // The stub 404 body is short; assert the cap contractually instead: the
  // endpoint promises error.length <= 300.
  const res = await probe({ model: 'bad-model' });
  const r = await res.json();
  assert.ok(r.error.length <= 300, `error not capped: ${r.error.length}`);
});
