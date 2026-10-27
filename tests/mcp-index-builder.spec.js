import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSearchIndex } from '../mcp/build/index-builder.ts';

test('an iframe entry without name or description still yields a valid search index', () => {
  const root = mkdtempSync(join(tmpdir(), 'kb-mcp-index-'));
  try {
    writeFileSync(join(root, 'apps.json'), JSON.stringify([{ type: 'iframe', slug: 'external', url: 'https://example.com/docs', temporary: true }]));
    const searchIndex = buildSearchIndex({ root });
    expect(searchIndex.apps).toEqual([expect.objectContaining({ slug: 'external', name: 'external', description: '' })]);
    expect(searchIndex.documents[0].title).toBe('external');
    expect(searchIndex.documents[0].text).toBe('# external\n\nExternal documentation: https://example.com/docs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
