import { defineConfig, devices } from '@playwright/test';

// Headless-only config for the homelab box. The chromium browser is pre-cached
// under ~/.cache/ms-playwright (chromium-1223), matched to @playwright/test
// 1.60.0 so no download is triggered. Each spec boots the War Room server
// itself via tests/_helpers.mjs spawnServer (isolated temp DB), so there is no
// global webServer here.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.e2e\.mjs$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
