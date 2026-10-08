import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildCorpus, writeCorpus } from '../mcp/corpus.js';

/** Generate runtime-only corpus and self-contained server bundle after Astro output exists. */
export async function buildMcpArtifacts({ root, headless, provenance = [], log = {} }) {
  const out = join(root, 'dist', '_mcp'); mkdirSync(out, { recursive: true });
  const versions = Object.fromEntries(provenance.flatMap((entry) => entry.slugs.map((slug) => [slug, entry.label])));
  const corpus = buildCorpus({ root, headless, versions, warn: log.warn ?? (() => {}) });
  writeCorpus(join(out, 'corpus.json'), corpus);
  await build({ entryPoints: [join(root, 'mcp', 'main.js')], outfile: join(out, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'bundle', legalComments: 'none' });
  log.ok?.(`MCP corpus (${corpus.documents.length} documents) and server bundle published → dist/_mcp/`);
  return corpus;
}
