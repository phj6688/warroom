/**
 * The Infisical access token must reach `infisical run` through the
 * environment. A `--token=` argument is readable by every local user via
 * /proc/<pid>/cmdline.
 *
 * Strategy: run docker/entrypoint.sh against a stub `infisical` on PATH that
 * answers `login` with a fixed fake token and, for `run`, reports its own argv
 * and whether INFISICAL_TOKEN is set. The stub never prints the token value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docker', 'entrypoint.sh');
const FAKE_TOKEN = 'fake-access-token-for-test';

const STUB = `#!/bin/sh
case "$1" in
  login) printf '%s' '${FAKE_TOKEN}' ;;
  run)
    echo "ARGV: $*"
    if [ -n "\${INFISICAL_TOKEN:-}" ]; then echo "CLI_TOKEN_ENV: set"; else echo "CLI_TOKEN_ENV: unset"; fi
    if [ "\${INFISICAL_TOKEN:-}" = '${FAKE_TOKEN}' ]; then echo "CLI_TOKEN_MATCH: yes"; else echo "CLI_TOKEN_MATCH: no"; fi
    if [ -n "\${INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN:-}" ]; then echo "CLI_STALE_ENV: set"; else echo "CLI_STALE_ENV: unset"; fi
    while [ "$1" != "--" ]; do shift; done
    shift
    exec "$@"
    ;;
esac
`;

const APP = [
  'if [ -n "${INFISICAL_TOKEN:-}" ]; then echo "APP_TOKEN_ENV: set"; else echo "APP_TOKEN_ENV: unset"; fi',
  'if [ -n "${INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN:-}" ]; then echo "APP_STALE_ENV: set"; else echo "APP_STALE_ENV: unset"; fi',
  'echo "APP_LOG_LEVEL: ${LOG_LEVEL:-none}"',
].join('; ');

function runEntrypoint() {
  const dir = mkdtempSync(join(tmpdir(), 'wr-entry-'));
  try {
    writeFileSync(join(dir, 'infisical'), STUB);
    chmodSync(join(dir, 'infisical'), 0o755);
    return spawnSync('sh', [ENTRYPOINT, 'sh', '-c', APP], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: 'stale-token',
        LOG_LEVEL: 'debug',
        INFISICAL_PROJECT_ID: 'proj-test',
        INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: 'client-id-test',
        INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: 'client-secret-test',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('entrypoint passes the access token by environment, not argv', () => {
  const r = runEntrypoint();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ARGV: run /m);
  assert.doesNotMatch(r.stdout, /--token/);
  assert.ok(!r.stdout.includes(FAKE_TOKEN), 'token value must not appear in argv');
  assert.match(r.stdout, /^CLI_TOKEN_ENV: set$/m);
  assert.match(r.stdout, /^CLI_TOKEN_MATCH: yes$/m);
  assert.match(r.stdout, /^CLI_STALE_ENV: unset$/m);
});

test('the app process never receives the access token variables', () => {
  const r = runEntrypoint();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^APP_TOKEN_ENV: unset$/m);
  assert.match(r.stdout, /^APP_STALE_ENV: unset$/m);
  assert.match(r.stdout, /^APP_LOG_LEVEL: debug$/m, 'the app keeps its own LOG_LEVEL');
});

test('the CLI is pinned to a non-debug log level', () => {
  const r = runEntrypoint();
  assert.match(r.stdout, /^ARGV: run .*--log-level=info/m);
  assert.doesNotMatch(r.stdout, /--log-level=(debug|trace)/);
});
