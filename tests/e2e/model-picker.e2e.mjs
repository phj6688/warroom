/**
 * Every model field in the Settings panel is a combobox: its dropdown lists
 * the ids the row's selected provider actually serves, typing filters the
 * list, clicking an item fills the field, and a free-typed id stays valid.
 * A stub gateway keys its catalog off the bearer token, so the default route
 * and ollama-local return different lists and the popup provably follows the
 * row's route.
 */
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { spawnServer, getFreePort } from '../_helpers.mjs';

const CATALOGS = {
  'stub-key': ['claude-opus-5', 'gpt-5.5', 'gpt-5.6-sol'],
  'ollama': ['qwen3:30b-a3b'],
};

test.describe('Settings model picker', () => {
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

  test('dropdown lists the route catalog, filters on typing, fills on click, allows free text', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });
    await page.click('#settings-btn');
    await expect(page.locator('#settings-overlay')).toBeVisible();

    // The ▾ toggle opens the default provider's full catalog.
    const allRow = page.locator('.settings-all-row');
    await allRow.locator('.sa-model-toggle').click();
    await expect(page.locator('#model-picker')).toBeVisible();
    await expect(page.locator('#model-picker .model-picker-item')).toHaveCount(3);
    await expect(page.locator('#model-picker .model-picker-status')).toContainText('3 models');

    // Typing filters the open list without restricting the field.
    await allRow.locator('.sa-model').fill('gpt');
    await expect(page.locator('#model-picker .model-picker-item')).toHaveCount(2);

    // Clicking an item fills the field and closes the popup.
    await page.locator('#model-picker .model-picker-item', { hasText: 'gpt-5.6-sol' }).click();
    await expect(allRow.locator('.sa-model')).toHaveValue('gpt-5.6-sol');
    await expect(page.locator('#model-picker')).toHaveCount(0);

    // A row pointed at ollama-local gets that provider's catalog instead.
    const firstRow = page.locator('#settings-agents .settings-agent-row').first();
    await firstRow.locator('.sa-route').selectOption('ollama-local');
    await firstRow.locator('.sa-model-toggle').click();
    await expect(page.locator('#model-picker .model-picker-item')).toHaveCount(1);
    await expect(page.locator('#model-picker .model-picker-item')).toHaveText('qwen3:30b-a3b');

    // Keyboard: ArrowDown + Enter picks the highlighted id.
    await firstRow.locator('.sa-model-toggle').click(); // close
    await firstRow.locator('.sa-model-toggle').click(); // reopen fresh
    await firstRow.locator('.sa-model').press('ArrowDown');
    await firstRow.locator('.sa-model').press('Enter');
    await expect(firstRow.locator('.sa-model')).toHaveValue('qwen3:30b-a3b');
    await expect(page.locator('#model-picker')).toHaveCount(0);

    // Free text survives: no dropdown value is forced on the field.
    await firstRow.locator('.sa-model').fill('anything-i-like');
    await expect(page.locator('#model-picker .model-picker-empty')).toContainText('custom id', { ignoreCase: true });
    await page.keyboard.press('Escape');
    await expect(firstRow.locator('.sa-model')).toHaveValue('anything-i-like');

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });
});
