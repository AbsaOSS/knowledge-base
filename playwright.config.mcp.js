// playwright.config.mcp.js — the MCP suites alone, without the browser harness.
//
// Nothing is built: run `node scripts/setup-test-apps.mjs && npm run build:headless`
// (or `npm test` once) first, so dist/_mcp/search-index.json exists.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['mcp-*.spec.js'],
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
});
