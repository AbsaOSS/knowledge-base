import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateSearchIndex } from '../mcp/search-index/schema.ts';
import { memoryKnowledgeBase } from '../mcp/src/compose.ts';

const searchIndex = validateSearchIndex(JSON.parse(readFileSync(join(process.cwd(), 'dist', '_mcp', 'search-index.json'), 'utf8')));
const index = memoryKnowledgeBase(searchIndex);
const search = (kb, params) => kb.search(params);
const readDocument = (kb, params) => kb.read(params);

const document = (uri, app, title, text, tags = []) => ({
  uri, app, route: `/knowledge-base/${uri.slice(5)}/`, title, description: text.slice(0, 120), tags,
  mimeType: 'text/markdown', sourceVersion: 'test', sha256: '0'.repeat(64), size: text.length,
  truncated: false, text, sections: [{ heading: title, anchor: null, level: 1, start: 0, end: text.length }],
});
const exampleSearchIndex = {
  schemaVersion: 1,
  contentHash: 'synthetic-user-examples',
  apps: [
    { slug: 'agentic-toolkit', name: 'Agentic Toolkit', description: 'Automation skills.', tags: ['automation'] },
    { slug: 'service-accounts', name: 'Service Accounts', description: 'Service account operations.', tags: ['identity'] },
    { slug: 'eventbus', name: 'Event Bus', description: 'Event platform documentation.', tags: ['events'] },
  ],
  documents: [
    document('kb://agentic-toolkit/skills/aquasec-suppress', 'agentic-toolkit', 'AquaSec suppress', '# AquaSec suppress\n\nGenerate an AquaSec suppression report.\n\n## Configuration\n\nInstall skill and configure report settings.\n\n## Use\n\nUse prompt examples to generate and review suppression reports.', ['security']),
    document('kb://agentic-toolkit/skills/aquasec-false-positives', 'agentic-toolkit', 'AquaSec false positives', '# AquaSec false positives\n\nReview AquaSec findings without generating a suppression report.', ['security']),
    document('kb://service-accounts/password-rotation', 'service-accounts', 'Rotating service account passwords', '# Rotating service account passwords\n\nRotate passwords for service accounts with staged credential rollout.', ['identity']),
    document('kb://eventbus', 'eventbus', 'Event Bus', '# Event Bus\n\nEventBus is platform for publishing and consuming domain events.', ['events']),
  ],
};
const exampleIndex = memoryKnowledgeBase(exampleSearchIndex);

test.describe('MCP generated search index', () => {
  test('search finds release process and bounded read returns text', async () => {
    const result = await search(index, { query: 'release process' });
    expect(result.results[0].uri).toBe('kb://release-process');
    const read = await readDocument(index, { uri: result.results[0].uri, maxChars: 1000 });
    expect(read.text).toContain('Release Process');
    expect(read.text.length).toBeLessThanOrEqual(1000);
  });

  test('search is deterministic for normalized query terms', async () => {
    const query = 'ReleaseProcess';
    expect(await search(index, { query })).toEqual(await search(index, { query }));
  });

  test('ranks all three user-facing natural-language examples', async () => {
    const aqua = await search(exampleIndex, { query: 'I would like to create aquasec suppresion report, how do I do that' });
    expect(aqua.results[0].uri).toBe('kb://agentic-toolkit/skills/aquasec-suppress');
    const aquaDocument = exampleSearchIndex.documents.find((entry) => entry.uri === aqua.results[0].uri);
    expect(aquaDocument.text).toContain('Configuration');
    expect(aquaDocument.text).toContain('Use');

    expect((await search(exampleIndex, { query: 'How do I rotate passwords for service accounts?' })).results[0].uri)
      .toBe('kb://service-accounts/password-rotation');
    expect((await search(exampleIndex, { query: "What's EventBus?" })).results[0].uri).toBe('kb://eventbus');
    expect((await search(exampleIndex, { query: 'Event Bus' })).results[0].uri).toBe('kb://eventbus');
  });

  test('a long multi-word query stays cheap against a large vocabulary', async () => {
    const words = Array.from({ length: 50000 }, (_, i) => `term${i.toString(36)}x${'y'.repeat(i % 40)}`);
    const big = memoryKnowledgeBase({ ...exampleSearchIndex, contentHash: 'big', documents: [...exampleSearchIndex.documents, document('kb://eventbus/vocabulary', 'eventbus', 'Vocabulary', words.join(' '))] });
    const query = 'rotate passwords for service accounts using the staged credential rollout procedure documented somewhere in here please';
    const start = Date.now();
    expect((await search(big, { query })).results[0].uri).toBe('kb://service-accounts/password-rotation');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
