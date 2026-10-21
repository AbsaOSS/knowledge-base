// The shipped server: dist/_mcp/server.mjs, minified, with the bundle-only substitutions in
// mcp/build/bundle.ts (English-only zod locales, the small JSON Schema validator). It must
// answer exactly as the source does, and stay inside its size budget.
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnBundle, startMcp } from './support/mcp.js';
import { record } from './support/mcp-cases.js';
import { syntheticIndex } from './fixtures/mcp/synthetic-index.js';

const BUNDLE = join(process.cwd(), 'dist', '_mcp', 'server.mjs');
/** Measured at 407 KiB after the refactor; raise deliberately, never by accident. */
const BUNDLE_BUDGET_KIB = 450;

test.describe('MCP server bundle', () => {
  test('bundle budget', () => {
    const kib = statSync(BUNDLE).size / 1024;
    expect(kib, `server.mjs is ${kib.toFixed(0)} KiB`).toBeLessThanOrEqual(BUNDLE_BUDGET_KIB);
  });

  for (const [name, origin] of [['site-relative links', undefined], ['public origin', 'https://docs.example.com']]) {
    test(`answers every protocol case like the source (${name})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kb-mcp-bundle-'));
      const indexFile = join(dir, 'search-index.json');
      writeFileSync(indexFile, JSON.stringify(syntheticIndex));
      const source = await startMcp(syntheticIndex, { publicOrigin: origin });
      const bundle = await spawnBundle(BUNDLE, indexFile, origin ? { KB_MCP_PUBLIC_ORIGIN: origin } : {});
      try {
        expect(await record(bundle)).toEqual(await record(source));
      } finally {
        await Promise.all([source.close(), bundle.close()]);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
