/**
 * Shared test helpers — Session 0 (red phase) scaffolding.
 *
 * This file is intentionally NOT a *.test.mjs — node:test won't discover it.
 * It provides the minimum tooling to spawn the server in a child process and
 * inspect it through HTTP/WS, plus a few small utilities used by multiple
 * test files.
 *
 * The constraint from the spec is "no test file imports lib/* or server.js
 * directly". This helper does the same: it only imports node built-ins and
 * the project's `ws` dep (already in package.json).
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const SERVER_ENTRY = path.join(REPO_ROOT, 'server.js');

/**
 * Reserve a free TCP port by binding briefly. Race conditions are possible
 * but acceptable for tests; the OS will reuse the port immediately.
 */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawn the War Room server as a child process. Returns an object with:
 *   - proc:    the ChildProcess
 *   - port:    the chosen port
 *   - baseUrl: http://127.0.0.1:<port>
 *   - wsUrl:   ws://127.0.0.1:<port>
 *   - logs:    array of stderr/stdout chunks for diagnostics
 *   - tempDbDir: path to the auto-created temp DB dir (cleaned up on dispose)
 *   - dispose: kill the process and wait for exit
 *
 * `env` is merged on top of process.env. The tests pass things like
 * WAR_ROOM_TOKEN, etc.
 *
 * DB isolation: every spawn gets its own temp WAR_ROOM_DB_PATH unless the
 * caller passes one explicitly. Without this default, tests that hit
 * /api/sessions or `new-session` would write fixture rows into the
 * canonical ./data/warroom.db, contaminating dev state and silently
 * breaking the session-history view (real classified sessions get pushed
 * past the LIMIT 50 window by fixture noise).
 */
export async function spawnServer({ env = {}, readyTimeoutMs = 8000 } = {}) {
  const port = await getFreePort();

  let tempDbDir = null;
  let dbPath = env.WAR_ROOM_DB_PATH;
  if (!dbPath) {
    tempDbDir = mkdtempSync(path.join(os.tmpdir(), 'warroom-test-db-'));
    dbPath = path.join(tempDbDir, 'warroom.db');
  }

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // Disable LLM noise during boot — tests don't make LLM calls.
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || 'test-key-no-real-calls',
      WAR_ROOM_DB_PATH: dbPath,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  proc.stdout.on('data', (d) => logs.push(`[out] ${d.toString()}`));
  proc.stderr.on('data', (d) => logs.push(`[err] ${d.toString()}`));

  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  // Poll /health until ready.
  const deadline = Date.now() + readyTimeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `server exited with code ${proc.exitCode} before ready\n${logs.join('')}`
      );
    }
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.ok) break;
    } catch (e) {
      lastErr = e;
    }
    await delay(100);
  }
  if (Date.now() >= deadline) {
    proc.kill('SIGKILL');
    throw new Error(
      `server did not become ready within ${readyTimeoutMs}ms (last err: ${lastErr?.message})\n${logs.join('')}`
    );
  }

  return {
    proc,
    port,
    baseUrl,
    wsUrl,
    logs,
    tempDbDir,
    dbPath,
    async dispose() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
        // Give it 1 s to clean up; force kill otherwise.
        const killed = await Promise.race([
          new Promise((r) => proc.once('exit', () => r(true))),
          delay(1000).then(() => false),
        ]);
        if (!killed) proc.kill('SIGKILL');
      }
      if (tempDbDir) {
        try { rmSync(tempDbDir, { recursive: true, force: true }); } catch {}
      }
    },
  };
}

/**
 * Create a temp dir for a test that needs file-system isolation.
 * Caller is responsible for cleanup via the returned `cleanup()` fn.
 */
export function makeTempDir(prefix = 'warroom-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Run an inline node script as a child process. Used by tests that need to
 * exercise lib/* code without importing it from the test file directly.
 *
 * Returns {code, stdout, stderr}.
 */
export function runNodeScript(source, { env = {}, cwd = REPO_ROOT, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', source], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`runNodeScript timed out after ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Wait for an event/condition with a timeout. Returns the resolved value or
 * throws on timeout.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await predicate();
    if (v) return v;
    await delay(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label}`);
}

export { delay };
