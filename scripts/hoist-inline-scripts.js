/**
 * hoist-inline-scripts.js — move inline <script> bodies into files.
 *
 * WHY
 *
 * The marketplace serves a Content-Security-Policy with `script-src 'self'`. An
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
 * So the marketplace hoists them itself, at build time, before anything else
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
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

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
 * @returns {{html: string, written: number}}
 */
export function hoistInlineScripts(html, appDir, fileRelDir) {
  let written = 0;

  const out = html.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs, body) => {
      if (!isExecutableInline(attrs)) return match;
      if (body.trim() === '') return match;

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

  return { html: out, written };
}

/**
 * Applies hoistInlineScripts to every HTML file of an app, in place.
 *
 * @param {string} appDir    - apps/{slug}
 * @param {string[]} htmlFiles - absolute paths to that app's HTML files
 * @returns {number} how many scripts were hoisted
 */
export function hoistAppInlineScripts(appDir, htmlFiles) {
  let total = 0;
  for (const file of htmlFiles) {
    const fileRelDir = relative(appDir, dirname(file)).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    const { html, written } = hoistInlineScripts(source, appDir, fileRelDir === '.' ? '' : fileRelDir);
    if (written > 0) {
      writeFileSync(file, html);
      total += written;
    }
  }
  return total;
}
