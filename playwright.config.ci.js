// playwright.config.ci.js
//
// Playwright configuration for CI — tests the standalone knowledge-base
// preview server (port 3000) WITHOUT requiring a running data-gateway host.
//
// Run with:
//   npx playwright test --config=playwright.config.ci.js
//
// The dist/ directory must exist before running (built by the CI build step).
// The webServer starts only `npm run preview:embedded` (no rebuild).
//
// For full integration tests (embedded inside data-gateway), use
// playwright.config.js and start data-gateway manually first.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/standalone.spec.js',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 20_000,

  use: {
    // Preview server serves Astro's built output directly on port 3000.
    // The wf-fragment-alias Vite plugin (astro.config.mjs) rewrites
    // /__wf/knowledge-base/* → /knowledge-base/* so asset routing tests work
    // without nginx.
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  webServer: {
    // dist/ must already exist — build step runs before playwright in CI.
    command: 'npm run preview:embedded',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
