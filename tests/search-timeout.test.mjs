// The Tavily provider only armed an AbortController when a caller passed
// timeoutMs, and server.js never passed one. A search that never answered
// therefore held the agent turn, the phase, and the deliberation open with no
// deadline at all. The timeout is now the provider's own default, so no caller
// can forget it, and a hung search degrades to "Search unavailable" instead of
// freezing the room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runNodeScript } from './_helpers.mjs';

const SCRIPT = `
const assert = require('assert');
const { createTavilyProvider } = require('./lib/search-providers/tavily');

(async () => {
  // 1. A provider built with no timeoutMs (the server's own call shape) still
  //    arms an abort signal.
  let seenSignal = 'never called';
  const inspect = createTavilyProvider({
    apiKey: 'k',
    fetch: async (_url, init) => {
      seenSignal = init && init.signal ? 'present' : 'absent';
      return { ok: true, json: async () => ({ results: [] }) };
    },
  });
  await inspect.search('anything');
  assert.equal(seenSignal, 'present', 'default provider must arm an abort signal');

  // 2. A gateway that never answers must not park the turn forever.
  const hung = createTavilyProvider({
    apiKey: 'k',
    timeoutMs: 300,
    fetch: (_url, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    }),
  });
  const t0 = Date.now();
  const out = await hung.search('anything');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, 'hung search resolved in ' + elapsed + 'ms, expected under 3000');
  assert.deepEqual(out.results, [], 'a timed-out search yields no results');
  assert.equal(out.meta.error, 'Search unavailable', 'and reports itself unavailable');
  console.log('search-timeout assertions passed');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`;

test('the search provider always carries a deadline, even when the caller sets none', async () => {
  const { code, stdout, stderr } = await runNodeScript(SCRIPT, { env: {} });
  assert.equal(code, 0, `script failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /search-timeout assertions passed/);
});
