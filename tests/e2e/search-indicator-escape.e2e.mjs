/*
 * HLB-884 — addSearchIndicator rendered LLM-generated search queries raw into
 * innerHTML (public/index.html), the one un-escaped dynamic-text sink. This
 * drives the real page: it calls addSearchIndicator with an <img onerror>
 * payload and asserts the payload is inert (no element created, no handler
 * fired, shown as literal text) because the query is now escaped with escHtml.
 */
import { test, expect } from '@playwright/test';
import { spawnServer } from '../_helpers.mjs';

test('addSearchIndicator escapes query text, no XSS (HLB-884)', async ({ page }) => {
  const server = await spawnServer({ env: {} });
  try {
    await page.goto(server.baseUrl, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(() => {
      if (typeof addSearchIndicator !== 'function') return { err: 'addSearchIndicator is not a page global' };
      if (!document.getElementById('feed')) {
        const f = document.createElement('div'); f.id = 'feed'; document.body.appendChild(f);
      }
      window.__xssFired = false;
      addSearchIndicator(['<img src=x onerror="window.__xssFired=true">']);
      const ind = document.getElementById('search-indicator');
      const label = ind && ind.querySelector('.thinking-label');
      return { hasImg: !!(ind && ind.querySelector('img')), label: label ? label.textContent : null };
    });

    if (result.err) throw new Error(result.err);
    // Give a would-be <img> onerror time to fire (it must NOT, post-fix).
    await page.waitForTimeout(400);
    const fired = await page.evaluate(() => window.__xssFired === true);

    expect(fired).toBe(false);                 // no onerror handler ran
    expect(result.hasImg).toBe(false);         // no <img> element was injected
    expect(result.label).toContain('<img');    // the payload shows as literal text
  } finally {
    await server.dispose();
  }
});
