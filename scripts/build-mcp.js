import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSearchIndex, writeSearchIndex } from '../mcp/build/index-builder.ts';

/** Generate the runtime search index, after the Astro output exists. */
export async function buildMcpArtifacts({ root, headless, provenance = [], log = {} }) {
  const out = join(root, 'dist', '_mcp');
  mkdirSync(out, { recursive: true });

  const versions = Object.fromEntries(provenance.flatMap((entry) => entry.slugs.map((slug) => [slug, entry.label])));
  const searchIndex = buildSearchIndex({ root, headless, versions, warn: log.warn ?? (() => {}) });
  writeSearchIndex(join(out, 'search-index.json'), searchIndex);

  log.ok?.(`MCP search index (${searchIndex.documents.length} documents) published → dist/_mcp/`);
  return searchIndex;
}
