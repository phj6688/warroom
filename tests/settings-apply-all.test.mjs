// Settings panel: the "apply to all agents" master row must stay wired into
// the static HTML and styled. Static presence assertions in the same spirit as
// the verify.sh checks; interactive behavior is covered by the Playwright E2E
// flow (fill all rows, save, roundtrip through /api/settings/agent-routing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(join(root, 'public', 'index.html'), 'utf-8');
const css = readFileSync(join(root, 'public', 'app.css'), 'utf-8');

test('settings modal carries the apply-all master controls', () => {
  for (const id of ['settings-all-route', 'settings-all-model', 'settings-all-apply']) {
    assert.ok(html.includes(`id="${id}"`), `${id} missing from index.html`);
  }
  assert.ok(html.includes('function applyAllRouting'), 'applyAllRouting handler missing');
  assert.ok(html.includes("getElementById('settings-all-apply').addEventListener"), 'apply button not bound');
});

test('master row is excluded from saveSettings collection', () => {
  // saveSettings collects .settings-agent-row only; the master row must not
  // carry that class or a data-aid, or Save would persist a bogus agent id.
  const masterRow = html.match(/<div class="settings-all-row">[\s\S]*?<\/div>/);
  assert.ok(masterRow, 'settings-all-row markup missing');
  assert.ok(!masterRow[0].includes('settings-agent-row'), 'master row must not be a settings-agent-row');
  assert.ok(!masterRow[0].includes('data-aid'), 'master row must not carry data-aid');
});

test('apply-all styles exist in app.css', () => {
  assert.ok(css.includes('.settings-all-row'), 'settings-all-row style missing');
  assert.ok(css.includes('.settings-all-apply'), 'settings-all-apply style missing');
});
