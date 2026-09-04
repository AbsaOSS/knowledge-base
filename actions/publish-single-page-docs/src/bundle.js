/**
 * bundle.js — assembles the single-page bundle and packs it as dist.tar.gz.
 *
 * Layout of the staging directory (and therefore of the tarball):
 *
 *   bundle.json                 ← manifest listing every doc in this bundle
 *   {slug}/index.html           ← headless document
 *   {slug}/assets/doc.css
 *   {slug}/assets/mermaid.min.js   (only when that doc uses mermaid)
 *   {slug}/assets/mermaid-init.js  (ditto — kept out of the HTML so the
 *                                   knowledge base can run script-src 'self')
 *
 * One release asset carries every doc from the repo; the knowledge base expands
 * the manifest into one knowledge base app per doc (see contract/SINGLE_PAGE.md).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import { renderMarkdown } from './markdown.js';
import {
  CSS_PATH, DOC_CSS, MERMAID_INIT_JS, MERMAID_INIT_PATH, MERMAID_PATH, renderDocument,
} from './template.js';

const require = createRequire(import.meta.url);

/** Manifest file name — must match src/utils/single-page.js in the knowledge base. */
export const BUNDLE_MANIFEST = 'bundle.json';
/** Release asset name — must match what scripts/fetch-apps.js looks for. */
export const ASSET_NAME = 'dist.tar.gz';

/**
 * Renders every validated doc into `stageDir` and writes the bundle manifest.
 *
 * @param {Array}  docs     - output of validateDocs()
 * @param {string} stageDir - empty directory to build into
 * @returns {{manifest: object, rendered: Array}}
 */
export function buildBundle(docs, stageDir) {
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const rendered = [];

  for (const doc of docs) {
    const source = readFileSync(doc.mdAbs, 'utf8');
    const { html, usesMermaid, hasHeading } = renderMarkdown(source);

    const docDir = join(stageDir, doc.slug);
    mkdirSync(join(docDir, dirname(CSS_PATH)), { recursive: true });

    writeFileSync(join(docDir, 'index.html'), renderDocument({
      title:       doc.title,
      description: doc.description,
      bodyHtml:    html,
      usesMermaid,
      hasHeading,
    }));
    writeFileSync(join(docDir, CSS_PATH), DOC_CSS);

    if (usesMermaid) {
      copyFileSync(resolveMermaidBundle(), join(docDir, MERMAID_PATH));
      // The init runs from a file, not an inline <script>, so the knowledge base
      // can serve these pages under script-src 'self'.
      writeFileSync(join(docDir, MERMAID_INIT_PATH), MERMAID_INIT_JS);
    }

    rendered.push({ ...doc, usesMermaid });
  }

  const manifest = {
    marketplaceVersion: '1',
    type: 'single-page',
    docs: docs.map((doc) => ({
      slug:        doc.slug,
      title:       doc.title,
      description: doc.description,
      icon:        doc.icon,
      tags:        doc.tags,
      entryPoint:  'index.html',
    })),
  };
  writeFileSync(join(stageDir, BUNDLE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  return { manifest, rendered };
}

/**
 * Locates the vendored mermaid bundle.
 *
 * The UMD build is used deliberately: it is fully self-contained (no dynamic
 * chunk imports), so a doc directory copied into the knowledge base keeps working
 * behind the fragment CSP without any CDN.
 */
function resolveMermaidBundle() {
  try {
    return require.resolve('mermaid/dist/mermaid.min.js');
  } catch (err) {
    throw new Error(
      'A doc uses a ```mermaid block but the vendored mermaid bundle could not be ' +
      'resolved. Re-run the action (its dependencies are installed with `npm ci`).\n' +
      `Underlying error: ${err.message}`,
    );
  }
}

/**
 * Packs the staging directory as a gzipped tarball.
 *
 * The archive has no top-level wrapper directory — bundle.json sits at the root —
 * matching what the knowledge base expects when it extracts the release asset.
 *
 * @param {string} stageDir - the directory built by buildBundle()
 * @param {string} outPath  - destination .tar.gz path
 */
export function packBundle(stageDir, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });
  execFileSync('tar', ['-czf', basename(outPath), '-C', stageDir, '.'], {
    cwd: dirname(outPath),
    stdio: 'pipe',
  });
  return outPath;
}
