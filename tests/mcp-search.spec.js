import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIndex, search, readDocument } from '../mcp/search.js';
import { validateCorpus } from '../mcp/corpus.js';

const corpus = validateCorpus(JSON.parse(readFileSync(join(process.cwd(), 'dist', '_mcp', 'corpus.json'), 'utf8')));
const index = createIndex(corpus);

const document = (uri, app, title, text, tags = []) => ({
  uri, app, route: `/knowledge-base/${uri.slice(5)}/`, title, description: text.slice(0, 120), tags,
  mimeType: 'text/markdown', sourceVersion: 'test', sha256: '0'.repeat(64), size: text.length,
  truncated: false, text, sections: [{ heading: title, anchor: null, level: 1, start: 0, end: text.length }],
});
const exampleCorpus = {
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
const exampleIndex = createIndex(exampleCorpus);

test.describe('MCP generated corpus', () => {
  test('search finds release process and bounded read returns text', () => {
    const result = search(index, { query: 'release process' });
    expect(result.results[0].uri).toBe('kb://release-process');
    const read = readDocument(index, { uri: result.results[0].uri, maxChars: 1000 });
    expect(read.text).toContain('Release Process');
    expect(read.text.length).toBeLessThanOrEqual(1000);
  });

  test('search is deterministic for normalized query terms', () => {
    const query = 'ReleaseProcess';
    expect(search(index, { query })).toEqual(search(index, { query }));
  });

  test('ranks all three user-facing natural-language examples', () => {
    const aqua = search(exampleIndex, { query: 'I would like to create aquasec suppresion report, how do I do that' });
    expect(aqua.results[0].uri).toBe('kb://agentic-toolkit/skills/aquasec-suppress');
    const aquaDocument = exampleCorpus.documents.find((entry) => entry.uri === aqua.results[0].uri);
    expect(aquaDocument.text).toContain('Configuration');
    expect(aquaDocument.text).toContain('Use');

    expect(search(exampleIndex, { query: 'How do I rotate passwords for service accounts?' }).results[0].uri)
      .toBe('kb://service-accounts/password-rotation');
    expect(search(exampleIndex, { query: "What's EventBus?" }).results[0].uri).toBe('kb://eventbus');
    expect(search(exampleIndex, { query: 'Event Bus' }).results[0].uri).toBe('kb://eventbus');
  });
});
