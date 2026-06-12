/**
 * HLB-336 — the Settings panel must let the operator pick a per-agent model and
 * provider route, persist it, and have it take effect (resolveRoute picks it up)
 * without a restart. Driven against a live server with an isolated temp DB.
 * Routes without credentials in this deployment render disabled. No LLM calls.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const ART = (process.env.CLAUDE_JOB_DIR && path.join(process.env.CLAUDE_JOB_DIR, 'tmp', 'hlb-336-shots')) || '/tmp/hlb-336-shots';
mkdirSync(ART, { recursive: true });

test.describe('HLB-336 agent model + provider settings', () => {
  let server;
  test.beforeAll(async () => { server = await spawnServer(); });
  test.afterAll(async () => { if (server) await server.dispose(); });

  test('lists agents, disables key-less routes, persists a route+model, and applies it', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof ws !== 'undefined' && ws && ws.readyState === 1, null, { timeout: 8000 });

    // The entry point lives on the always-visible welcome view (next to the
    // council presets), not inside the hide-when-empty history panel.
    await page.click('#settings-btn');
    await expect(page.locator('#settings-overlay')).toBeVisible();

    const rows = page.locator('#settings-agents .settings-agent-row');
    await expect(rows).toHaveCount(8);

    // No OpenRouter key in this env => that option is disabled and labelled.
    const orOpt = rows.first().locator('option[value="openrouter"]');
    await expect(orOpt).toBeDisabled();
    await expect(orOpt).toContainText('no key');

    // Configure the first agent on a credential-free local route + a model.
    const firstRow = rows.first();
    const aid = await firstRow.getAttribute('data-aid');
    await firstRow.locator('.sa-route').selectOption('ollama-local');
    await firstRow.locator('.sa-model').fill('llama3.1:8b');
    await page.screenshot({ path: path.join(ART, 'settings-modal.png'), fullPage: false });
    await page.click('#settings-save');
    await expect(page.locator('#settings-overlay')).toBeHidden();

    // Reopen: the choice persisted and the form reflects it.
    await page.click('#settings-btn');
    await expect(page.locator(`.settings-agent-row[data-aid="${aid}"] .sa-route`)).toHaveValue('ollama-local');
    await expect(page.locator(`.settings-agent-row[data-aid="${aid}"] .sa-model`)).toHaveValue('llama3.1:8b');

    // And resolveRoute now picks it up (server-side effective resolution).
    const eff = await page.evaluate(async () => (await fetch('/api/settings/agent-routing').then((r) => r.json())).effective);
    expect(eff[aid].route).toBe('ollama-local');
    expect(eff[aid].model).toBe('llama3.1:8b');

    expect(consoleErrors, consoleErrors.join(' | ')).toEqual([]);
  });
});
