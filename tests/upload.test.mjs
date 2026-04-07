/**
 * F19 — Multer file upload allowlist.
 *
 * Spec: forge/hardening/TASKSPEC.md §F19
 *
 * Acceptance:
 *   - multer config in lib/routes.js adds a fileFilter rejecting MIME
 *     types not in the allowlist (text/* + a few application/* types).
 *   - Rejected files return 400 with {error: 'unsupported file type', mime}
 *   - Per-file size cap stays at 10 MB; total request cap added at 50 MB.
 *
 * In red phase: multer accepts everything; only the size cap is enforced.
 *
 * No new dependencies — we hand-build multipart bodies. The HTTP/1.1
 * multipart format is simple enough.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnServer } from './_helpers.mjs';

let server;

before(async () => {
  server = await spawnServer({ env: { WAR_ROOM_TOKEN: '' } });
});

after(async () => {
  await server?.dispose();
});

// ─── multipart helpers (file-local) ──────────────────────────
function buildMultipart(files) {
  const boundary = '----warroomtest' + Math.random().toString(16).slice(2);
  const chunks = [];
  for (const f of files) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="files"; filename="${f.name}"\r\n` +
      `Content-Type: ${f.mime}\r\n\r\n`
    ));
    chunks.push(Buffer.isBuffer(f.body) ? f.body : Buffer.from(f.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), boundary };
}

async function postFiles(baseUrl, files) {
  const { body, boundary } = buildMultipart(files);
  return fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

// ─── Tests ───────────────────────────────────────────────────
describe('F19 — /api/upload MIME allowlist', () => {
  test('text/plain file → 200 (control)', async () => {
    const res = await postFiles(server.baseUrl, [
      { name: 'note.txt', mime: 'text/plain', body: 'hello world' },
    ]);
    assert.equal(res.status, 200, '.txt must be accepted');
    const json = await res.json().catch(() => ({}));
    assert.equal(json.ok, true);
  });

  test('text/markdown file → 200', async () => {
    const res = await postFiles(server.baseUrl, [
      { name: 'README.md', mime: 'text/markdown', body: '# header\n\nbody' },
    ]);
    assert.equal(res.status, 200);
  });

  test('application/json file → 200', async () => {
    const res = await postFiles(server.baseUrl, [
      { name: 'data.json', mime: 'application/json', body: '{"k":"v"}' },
    ]);
    assert.equal(res.status, 200);
  });

  test('image/png file → 400 with "unsupported file type"', async () => {
    // Minimal valid PNG magic bytes — multer just looks at the declared MIME.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await postFiles(server.baseUrl, [
      { name: 'evil.png', mime: 'image/png', body: png },
    ]);
    assert.equal(res.status, 400, 'PNG must be rejected');
    const json = await res.json().catch(() => ({}));
    assert.match(json.error || '', /unsupported file type/i);
    assert.ok(json.mime === 'image/png' || /image\/png/.test(JSON.stringify(json)), 'response must echo the rejected mime');
  });

  test('application/octet-stream → 400', async () => {
    const res = await postFiles(server.baseUrl, [
      { name: 'blob.bin', mime: 'application/octet-stream', body: Buffer.from([0, 1, 2, 3, 4]) },
    ]);
    assert.equal(res.status, 400);
  });

  test('text/plain >10 MB → 400 (existing per-file size cap)', async () => {
    const oversized = Buffer.alloc(11 * 1024 * 1024, 0x61); // 11 MB of 'a'
    const res = await postFiles(server.baseUrl, [
      { name: 'huge.txt', mime: 'text/plain', body: oversized },
    ]);
    assert.equal(res.status, 400, '>10 MB file must be rejected by per-file cap');
  });

  test('mixed allowed + denied → entire request 400 (no partial save)', async () => {
    const res = await postFiles(server.baseUrl, [
      { name: 'ok.txt', mime: 'text/plain', body: 'allowed' },
      { name: 'bad.exe', mime: 'application/x-msdownload', body: Buffer.from([0x4d, 0x5a]) },
    ]);
    assert.equal(res.status, 400, 'mixed allowed+denied must be rejected as a whole');
  });
});
