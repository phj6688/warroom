/**
 * lib/embeddings.js — embed-gateway client.
 *
 * Covers SC10/R26: OpenAI response shape (`data[0].embedding`), structured
 * error body parsing (`{error: {code, message, request_id}}`), and the
 * load-bearing graceful-degradation contract (every failure path returns
 * null; callers in lib/memory.js + lib/routes.js depend on this).
 *
 * Strategy: stand up a tiny in-test HTTP server, point EMBED_GATEWAY_URL at
 * it, and require lib/embeddings.js fresh per test so env changes take effect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EMBED_MOD = path.join(REPO_ROOT, 'lib', 'embeddings.js');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(srv) {
  return new Promise((resolve) => srv.close(() => resolve()));
}

function loadEmbedModule({ url, model, dim, timeoutMs } = {}) {
  // Each test loads the module against fresh env. Use a one-off require cache
  // by spinning a fresh `createRequire` rooted at the same file.
  const requireFresh = createRequire(pathToFileURL(EMBED_MOD));
  delete requireFresh.cache[EMBED_MOD];
  if (url !== undefined) process.env.EMBED_GATEWAY_URL = url;
  if (model !== undefined) process.env.EMBED_MODEL = model;
  if (dim !== undefined) process.env.EMBEDDING_DIM = String(dim);
  if (timeoutMs !== undefined) process.env.EMBEDDING_TIMEOUT_MS = String(timeoutMs);
  return requireFresh(EMBED_MOD);
}

test('SC10 — parses OpenAI response shape data[0].embedding into Float32Array(768)', async () => {
  const captured = { body: null, url: null };
  const vec = new Array(768).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1));
  const { srv, url } = await startServer((req, res, body) => {
    captured.body = JSON.parse(body);
    captured.url = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ embedding: vec, index: 0, object: 'embedding' }],
      model: 'nomic-embed-text',
      object: 'list',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }));
  });
  try {
    const { embed, EMBEDDING_DIM } = loadEmbedModule({ url });
    assert.equal(EMBEDDING_DIM, 768);
    const result = await embed('hello world');
    assert.ok(result instanceof Float32Array, 'returns a Float32Array');
    assert.equal(result.length, 768);
    assert.equal(captured.url, '/v1/embeddings');
    assert.equal(captured.body.model, 'nomic-embed-text');
    assert.equal(captured.body.input, 'hello world');
    // Spot-check that we didn't accidentally pass a `dimensions` arg.
    assert.equal(captured.body.dimensions, undefined);
  } finally {
    await stopServer(srv);
  }
});

test('SC10 — structured error body {error:{code,message,request_id}} → null + logs request_id', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: 'model_not_found',
        message: 'unknown model "fake-model"',
        request_id: 'req_abc123',
      },
    }));
  });
  try {
    // pino writes directly to fd 2, bypassing process.stderr.write.
    // Run the call in a child process so we can capture stderr cleanly.
    const { spawn } = await import('node:child_process');
    const proc = spawn(process.execPath, ['-e', `
      process.env.EMBED_GATEWAY_URL = ${JSON.stringify(url)};
      process.env.EMBED_MODEL = 'fake-model';
      const { embed } = require(${JSON.stringify(EMBED_MOD)});
      embed('hi').then((r) => {
        process.stdout.write(JSON.stringify({ result: r }));
        process.exit(0);
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => { stdout += c.toString(); });
    proc.stderr.on('data', (c) => { stderr += c.toString(); });
    const code = await new Promise((r) => proc.on('exit', r));
    assert.equal(code, 0, `child exited non-zero: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.result, null, 'graceful degradation — returns null on HTTP 4xx');
    assert.ok(
      stderr.includes('req_abc123'),
      `expected request_id in log output, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes('model_not_found'),
      `expected error code in log output, got: ${stderr}`,
    );
  } finally {
    await stopServer(srv);
  }
});

test('graceful degradation — HTTP 500 returns null (does not throw)', async () => {
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: { code: 'provider_unavailable', message: 'upstream dead', request_id: 'req_500' },
    }));
  });
  try {
    const { embed } = loadEmbedModule({ url });
    const result = await embed('hi');
    assert.equal(result, null);
  } finally {
    await stopServer(srv);
  }
});

test('graceful degradation — timeout returns null (does not throw)', async () => {
  // Server that never responds.
  const { srv, url } = await startServer((req, res) => {
    // Intentionally do nothing; let the client time out.
    req.socket.setKeepAlive(false);
  });
  try {
    const { embed } = loadEmbedModule({ url, timeoutMs: 50 });
    const result = await embed('hi');
    assert.equal(result, null);
  } finally {
    await stopServer(srv);
  }
});

test('graceful degradation — connection refused returns null', async () => {
  // Pick a port nothing is listening on — bind one and immediately close.
  const { srv } = await startServer(() => {});
  const port = srv.address().port;
  await stopServer(srv);
  const { embed } = loadEmbedModule({ url: `http://127.0.0.1:${port}` });
  const result = await embed('hi');
  assert.equal(result, null);
});

test('dimension mismatch returns null (catalog/gateway drift guard)', async () => {
  const { srv, url } = await startServer((req, res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 512 dims instead of expected 768 — simulates an upstream model swap.
    res.end(JSON.stringify({
      data: [{ embedding: new Array(512).fill(0), index: 0 }],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }));
  });
  try {
    const { embed } = loadEmbedModule({ url });
    const result = await embed('hi');
    assert.equal(result, null);
  } finally {
    await stopServer(srv);
  }
});

test('no legacy Ollama shape support — {embeddings:[[...]]} returns null', async () => {
  // Old `/api/embed` response shape. The new client must NOT silently accept
  // it; a caller mis-pointed at raw Ollama needs to break loudly.
  const { srv, url } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      embeddings: [new Array(768).fill(0.5)],
      model: 'nomic-embed-text',
    }));
  });
  try {
    const { embed } = loadEmbedModule({ url });
    const result = await embed('hi');
    assert.equal(result, null);
  } finally {
    await stopServer(srv);
  }
});
