// playwright.config.js
import { defineConfig, devices } from '@playwright/test';

/**
 * E2E config for the knowledge-base embedded as a web fragment.
 *
 * Two servers are started automatically (no external data-gateway needed):
 *   1. :3000  knowledge-base — built from the local prebuilt docs example
 *             (setup-test-apps → build:headless) and served by tests/fragment-server.mjs
 *             (mirrors the production nginx rewrites; astro preview does not).
 *   2. :4201  host gateway   — tests/host/server.mjs, a minimal "wrapping
 *             web-fragment application" that proxies/embeds the :3000 fragment.
 *
 * Tests drive the HOST origin (:4201); the fragment is reached through it on a
 * single origin, exactly as in production.
 */
export default defineConfig({
  testDir: './tests',
  // standalone.spec.js targets the fragment server directly on :3000 — it has its
  // own config (playwright.config.ci.js). This embedded config drives the host
  // gateway on :4201, so exclude it here.
  testIgnore: '**/standalone.spec.js',
  fullyParallel: false, // fragments share DOM/history — keep navigation sequential
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,

  use: {
    baseURL: 'http://localhost:4201',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
  },

  webServer: [
    {
      // Generate the hermetic registry, build the fragment from the prebuilt
      // docs example, then serve it on :3000.
      command: 'node scripts/setup-test-apps.mjs && npm run build:headless && npm run serve:test',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // The wrapping web-fragment host (gateway). Proxies :3000 onto its origin.
      command: 'node tests/host/server.mjs',
      port: 4201,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
