// HLB-798 — verify.sh must exist, be executable, carry the anonymous gate probe
// + the files-service-config no-token assertion, and exit non-zero on failure.
// The full green path needs a live gated host, so CI covers structure + the
// non-zero-on-failure contract (run against an unreachable target).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'verify.sh');

test('verify.sh exists and is executable', () => {
  const mode = statSync(SCRIPT).mode;
  assert.ok(mode & 0o111, 'verify.sh must have an executable bit set');
});

test('verify.sh carries the required probes', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(src, /\/health/, 'must probe /health');
  assert.match(src, /files-service-config/, 'must assert on files-service-config');
  assert.match(src, /302\|401\|403/, 'gate probe must accept 302/401/403');
  assert.match(src, /token/i, 'must check for a leaked token field');
});

test('verify.sh exits non-zero when the target is unreachable', () => {
  // Point both URLs at a closed local port; every check fails -> non-zero exit.
  const r = spawnSync('bash', [SCRIPT], {
    cwd: REPO,
    env: {
      ...process.env,
      WARROOM_URL: 'http://127.0.0.1:1',
      WARROOM_PUBLIC_URL: 'http://127.0.0.1:1',
    },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.notEqual(r.status, 0, `expected non-zero exit, got ${r.status}\n${r.stdout}\n${r.stderr}`);
});
