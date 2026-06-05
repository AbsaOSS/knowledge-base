// playwright.config.js
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // fragments need sequential navigation
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,

  use: {
    baseURL: 'https://localhost:4201',
    ignoreHTTPSErrors: true, // self-signed cert on localhost
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Give the Angular app + fragment time to bootstrap
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
  },

  // Start the knowledge-base preview server before tests run.
  // Uses scripts/preview.js (no compression) — required for web-fragments gateway compatibility.
  // data-gateway must be started manually: cd ~/Projects/data-gateway && npm start
  webServer: {
    command: 'npm run build:local:headless && npm run preview:embedded',
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
