// playwright.config.mcp.js — the MCP suites alone, without the browser harness.
//
// Most of these start the MCP handler in-process; the error-page suite asks the fragment
// server, started here over the existing dist/. Nothing is built: run `make fixture-build`
// (or `npm test` once) first — `make test-mcp` does that when dist/_mcp/search-index.json is missing.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['mcp-*.spec.js'],
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  webServer: {
    command: 'node tests/fragment-server.mjs',
    port: 3000,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
