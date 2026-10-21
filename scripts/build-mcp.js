import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleServer } from '../mcp/build/bundle.ts';
import { buildSearchIndex, writeSearchIndex } from '../mcp/build/index-builder.ts';
import { renderErrorPage } from '../mcp/src/transport/error-page.ts';

/** Generate the runtime search index and the self-contained server bundle, after the Astro output exists. */
export async function buildMcpArtifacts({ root, headless, provenance = [], log = {} }) {
  const out = join(root, 'dist', '_mcp');
  mkdirSync(out, { recursive: true });

  const versions = Object.fromEntries(provenance.flatMap((entry) => entry.slugs.map((slug) => [slug, entry.label])));
  const searchIndex = buildSearchIndex({ root, headless, versions, warn: log.warn ?? (() => {}) });
  writeSearchIndex(join(out, 'search-index.json'), searchIndex);
  await bundleServer(join(out, 'server.mjs'));

  // nginx's error_page 404 serves this file for every missing route; without it each 404 becomes a 500.
  mkdirSync(join(root, 'dist', '_error'), { recursive: true });
  writeFileSync(join(root, 'dist', '_error', 'not-found.html'), renderErrorPage(404, 'site'));

  log.ok?.(`MCP search index (${searchIndex.documents.length} documents) and server bundle published → dist/_mcp/`);
  return searchIndex;
}
