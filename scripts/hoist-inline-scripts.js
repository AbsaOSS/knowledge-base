/**
 * hoist-inline-scripts.js — move inline <script> bodies into files.
 *
 * WHY
 *
 * The knowledge base serves a Content-Security-Policy with `script-src 'self'`. An
 * inline <script> anywhere in a page defeats that: allowing it means adding
 * 'unsafe-inline', which allows an injected script too, and hashing every one is
 * not possible because the HTML comes from other repositories' release artifacts.
 *
 * The publishing action no longer emits inline scripts (the mermaid init ships
 * as assets/mermaid-init.js). But bundles published *before* that change still
 * contain one, and this repository does not control when those repos re-publish.
 * Enforcing the CSP without this step would silently break every already-published
 * doc's diagrams — verified against the sibling example repo's real artifact.
 *
 * So the knowledge base hoists them itself, at build time, before anything else
 * reads apps/. Old bundles and new ones end up equally CSP-clean.
 *
 * ORDER IS PRESERVED
 *
 * A classic <script src> without defer/async blocks the parser exactly like an
 * inline script does, so hoisting does not reorder execution.
 *
 * WHAT IS LEFT ALONE
 *
 * Only executable scripts are hoisted. `application/ld+json`, `text/template`,
 * `importmap` and friends are data, not code — a CSP does not care about them
 * and moving them would break whatever reads them.
 *
 * WHAT IS DELETED
 *
 * A sub-app's dark-mode bootstrap is dropped rather than hoisted. The
 * knowledge base is light-only and src/utils/transform.js strips that script — but
 * only while it is still inline, and this step runs first. Hoisting it would
 * turn it into an external file the strip can no longer recognise, and it would
 * then run in the browser and re-add `dark` (#48).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isThemeBootstrap } from '../src/utils/transform.js';

/** Directory (relative to an app root) the hoisted files are written to. */
export const HOIST_DIR = '_kb-inline';

/** Script types that actually execute. Anything else is data. */
const EXECUTABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

/** True when a <script> tag's attributes describe executable, non-external code. */
function isExecutableInline(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return false; // already external
  const type = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i)?.[1]?.trim().toLowerCase() ?? '';
  return EXECUTABLE_TYPES.has(type);
}

/**
 * Rewrites one HTML document, writing each inline script to its own file.
 *
 * @param {string} html       - document source
 * @param {string} appDir     - app root on disk; hoisted files go under appDir/HOIST_DIR
 * @param {string} fileRelDir - the document's directory relative to appDir ('' at the root)
 * @returns {{html: string, written: number, dropped: number}}
 */
export function hoistInlineScripts(html, appDir, fileRelDir) {
  let written = 0;
  let dropped = 0;

  const out = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs, body) => {
      if (!isExecutableInline(attrs)) return match;
      if (body.trim() === '') return match;

      // Light-only: the theme bootstrap is deleted, not relocated.
      if (isThemeBootstrap(body)) { dropped++; return ''; }

      // Content-addressed: two pages sharing a bootstrap share one file, and a
      // rebuild of unchanged input produces an unchanged name.
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      const fileName = `${hash}.js`;
      mkdirSync(join(appDir, HOIST_DIR), { recursive: true });
      writeFileSync(join(appDir, HOIST_DIR, fileName), body);
      written++;

      // Emitted relative, so transform.js rewrites it to the absolute
      // /{prefix}/{slug}/… form along with every other URL in the document.
      const up = fileRelDir ? relative(join('x', fileRelDir), 'x').replace(/\\/g, '/') + '/' : '';
      const src = `${up}${HOIST_DIR}/${fileName}`;

      // Keep the original attributes (type="module" matters) minus the body.
      return `<script${attrs} src="${src}"></script>`;
    },
  );

  return { html: out, written, dropped };
}

/**
 * Applies hoistInlineScripts to every HTML file of an app, in place.
 *
 * @param {string} appDir    - apps/{slug}
 * @param {string[]} htmlFiles - absolute paths to that app's HTML files
 * @returns {{hoisted: number, dropped: number}} scripts moved to files, and theme
 *          bootstraps deleted
 */
export function hoistAppInlineScripts(appDir, htmlFiles) {
  let hoisted = 0;
  let dropped = 0;
  for (const file of htmlFiles) {
    const fileRelDir = relative(appDir, dirname(file)).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const result = hoistInlineScripts(source, appDir, fileRelDir === '.' ? '' : fileRelDir);
    if (result.written > 0 || result.dropped > 0) {
      writeFileSync(file, result.html);
      hoisted += result.written;
      dropped += result.dropped;
    }
  }
  return { hoisted, dropped };
}
