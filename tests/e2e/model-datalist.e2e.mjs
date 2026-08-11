/**
 * The Settings panel's model fields must suggest the ids the selected route's
 * provider actually serves. A stub gateway keys its catalog off the bearer
 * token, so the default route and ollama-local return different lists and the
 * shared datalist provably follows the focused row's route. Free text stays
 * valid; a datalist suggests, it never restricts.
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawnServer, getFreePort } from '../_helpers.mjs';

const CATALOGS = {
  'stub-key': ['claude-opus-5', 'gpt-5.5', 'gpt-5.6-sol'],
  'ollama': ['qwen3:30b-a3b'],
};

test.describe('Settings model datalist', () => {
  let stub, server;

  test.beforeAll(async () => {
    const stubPort = await getFreePort();
    stub = createServer((req, res) => {
      if (req.url === '/v1/models') {
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        const ids = CATALOGS[token] || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ids.map(id => ({ id })) }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
    server = await spawnServer({
      env: {
        OPENAI_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
        OPENAI_API_KEY: 'stub-key',
        MODEL: 'claude-opus-5',
        OLLAMA_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      },
    });
  });
  test.afterAll(async () => {
    if (server) await server.dispose();
    if (stub) await new Promise((r) => stub.close(r));
  });

  test('datalist fills from the default route and swaps with the focused row\'s route', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.click('#settings-btn');
    await expect(page.locator('#settings-overlay')).toBeVisible();

    // Opening the panel warms the default route's catalog.
    await expect(page.locator('#model-datalist option')).toHaveCount(3);
    await expect(page.locator('#model-datalist option[value="gpt-5.6-sol"]')).toHaveCount(1);

    // Point a row at ollama-local; focusing its model field swaps the list.
    const firstRow = page.locator('#settings-agents .settings-agent-row').first();
    await firstRow.locator('.sa-route').selectOption('ollama-local');
    await firstRow.locator('.sa-model').focus();
    await expect(page.locator('#model-datalist option')).toHaveCount(1);
    await expect(page.locator('#model-datalist option[value="qwen3:30b-a3b"]')).toHaveCount(1);

    // Back on a default-route row, the cached default catalog returns.
    await page.locator('#settings-all-model').focus();
    await expect(page.locator('#model-datalist option')).toHaveCount(3);

    // Suggestions never restrict: a free-typed id is kept as-is.
    await firstRow.locator('.sa-model').fill('anything-i-like');
    await expect(firstRow.locator('.sa-model')).toHaveValue('anything-i-like');

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });
});
