// Golden outputs: the byte-exact MCP responses, extraction text and generated search index this
// server produced before its refactor. A deliberate behaviour change regenerates them with
// `UPDATE_GOLDEN=1 npx playwright test tests/mcp-golden.spec.js --project=chromium`; any
// other diff here is a regression.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { extractDocument } from '../mcp/build/extract.ts';
import { startMcp } from './support/mcp.js';
import { CASES, FOLLOW_UPS, record } from './support/mcp-cases.js';
import { syntheticIndex } from './fixtures/mcp/synthetic-index.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'mcp');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Long strings are pinned by length and hash, so the golden files stay reviewable. */
const compact = (_key, value) => typeof value === 'string' && value.length > 2000
  ? { $string: { length: value.length, sha256: createHash('sha256').update(value).digest('hex'), head: value.slice(0, 160), tail: value.slice(-160) } }
  : value;

function golden(name, actual) {
  const file = join(FIXTURES, 'golden', `${name}.json`);
  const serialised = `${JSON.stringify(actual, compact, 2)}\n`;
  if (UPDATE || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serialised);
  }
  expect(serialised).toBe(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
}

test.describe('MCP golden outputs', () => {
  test('protocol transcript over the synthetic search index', async () => {
    const service = await startMcp(syntheticIndex, { resourcePageSize: 3 });
    try {
      const transcript = await record(service);
      for (const [label] of FOLLOW_UPS) expect(transcript, `${label} must run`).toHaveProperty([label]);
      golden('protocol', transcript);
    } finally { await service.close(); }
  });

  test('public URLs when a public origin is configured', async () => {
    const service = await startMcp(syntheticIndex, { publicOrigin: 'https://docs.example.com' });
    try {
      const transcript = {};
      for (const [label, method, params] of CASES.filter(([name]) => ['search: exact phrase', 'list: app', 'read: default', 'resources/list: page 1', 'resources/read: short'].includes(name))) {
        const { status, body } = await service.rpc(method, params);
        transcript[label] = { status, body };
      }
      golden('protocol-public-origin', transcript);
    } finally { await service.close(); }
  });

  test('extraction of a hostile, structure-rich page', () => {
    const html = readFileSync(join(FIXTURES, 'extract-rich.html'), 'utf8');
    golden('extract-rich', extractDocument(html, { fallbackTitle: 'Fallback', description: 'App description' }));
  });

  test('search index generated from the fixture build', () => {
    const searchIndex = JSON.parse(readFileSync(join(process.cwd(), 'dist', '_mcp', 'search-index.json'), 'utf8'));
    delete searchIndex.indexedAt;
    golden('dist-search-index', searchIndex);
  });
});
