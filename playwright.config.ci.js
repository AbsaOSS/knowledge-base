// playwright.config.ci.js
//
// Standalone Playwright layer — exercises the knowledge-base fragment server
// directly on port 3000 (no host gateway, no shadow DOM). Complements the full
// embedded harness in playwright.config.js.
//
// Run with:
//   npx playwright test --config=playwright.config.ci.js
//
// The fragment is served by tests/fragment-server.mjs, which mirrors the
// production nginx rewrites (including /__wf/knowledge-base/* → /knowledge-base/*).
// NB: `astro preview` is deliberately NOT used — its Vite configurePreviewServer
// rewrite hook does not run for static output, so the /__wf asset routing would
// 404. The build + serve here is hermetic (vendored fixture, no token/network).

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/standalone.spec.js',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 20_000,

  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: {
    command: 'node scripts/setup-test-apps.mjs && npm run build:headless && npm run serve:test',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
