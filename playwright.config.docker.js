// playwright.config.docker.js
//
// Container integration layer — drives the real production image (nginx serving
// dist/) instead of the Express mirror the other two suites use.
//
// Run with:
//   npm run build:headless
//   npx playwright test --config=playwright.config.docker.js
//
// The other suites run against tests/fragment-server.mjs, a hand-written mirror
// of the nginx rewrites. A mirror is only as faithful as the last person to
// update both sides: #45 (locations silently dropping inherited headers) and #60
// (a 308 where nginx does an internal rewrite) both survived because nothing
// ever exercised nginx.conf itself. This suite closes that gap.
//
// NOT hermetic — it needs Docker and `docker build` pulls the base image, so it
// is deliberately excluded from `npm test`. In CI it runs inside the job that
// already builds the image, reusing it via KB_SKIP_BUILD.
//
// Scope note: this verifies nginx faithfully. It does not cover the
// web-fragments gateway that sits in front of it in production — that is what
// the embedded harness in playwright.config.js is for.

import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.KB_CONTAINER_PORT || '8099';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/container.spec.js',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 20_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
  },

  webServer: {
    command: 'node tests/container/serve.mjs',
    // /healthz is the container's own health endpoint — the same one the
    // Dockerfile HEALTHCHECK uses.
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    // A cold `docker build` pulls the base image; give it room.
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  // Most assertions are plain HTTP requests against nginx, but the CSP ones need
  // a real browser: a policy that blocks something the page needs fails
  // silently, and only a browser reports the violation.
  projects: [{ name: 'nginx', use: { ...devices['Desktop Chrome'] } }],
});
