// HLB-796 — GET /api/files-service-config must never return FILES_SERVICE_TOKEN.
// The route is reachable by any caller when WAR_ROOM_TOKEN is unset (the prod
// default), so returning the token leaks a live credential. The browser only
// needs to know files-service is configured; uploads go through the
// /api/files/upload proxy, which injects the token server-side.
//
// Per the suite constraint, this file does not import lib/* or server.js
// directly; it spawns the real server and probes it over HTTP. A tiny stub
// answers /healthz so the server's boot health check passes with files-service
// "configured".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnServer, getFreePort } from './_helpers.mjs';

const SENTINEL_TOKEN = 'SENTINEL-FILES-TOKEN-DO-NOT-LEAK';

function startFilesServiceStub(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // Answer the boot health check; be permissive for anything else.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

test('GET /api/files-service-config returns url without the token when configured', async () => {
  const stubPort = await getFreePort();
  const stub = await startFilesServiceStub(stubPort);
  const server = await spawnServer({
    env: {
      FILES_SERVICE_URL: `http://127.0.0.1:${stubPort}`,
      FILES_SERVICE_TOKEN: SENTINEL_TOKEN,
    },
  });
  try {
    const res = await fetch(`${server.baseUrl}/api/files-service-config`);
    assert.equal(res.status, 200, 'configured files-service returns 200');
    const raw = await res.text();
    assert.ok(
      !raw.includes(SENTINEL_TOKEN),
      'the response body must not contain the files-service token'
    );
    const body = JSON.parse(raw);
    assert.equal(body.token, undefined, 'no token field in the response');
    assert.equal(body.url, `http://127.0.0.1:${stubPort}`, 'url is still returned');
  } finally {
    await server.dispose();
    await new Promise((r) => stub.close(r));
  }
});

test('GET /api/files-service-config returns 503 when files-service is not configured', async () => {
  const server = await spawnServer({
    env: { FILES_SERVICE_URL: '', FILES_SERVICE_TOKEN: '' },
  });
  try {
    const res = await fetch(`${server.baseUrl}/api/files-service-config`);
    assert.equal(res.status, 503, 'unconfigured files-service returns 503');
  } finally {
    await server.dispose();
  }
});
