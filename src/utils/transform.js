// src/utils/transform.js
//
// Pure sub-app HTML transformation utilities for the Astro catchall page.

import { chromeHtml, chromeScript, marketplaceRouterScript, shadowCompatStyle } from '../templates/chrome.js';

// ── URL rewriting ─────────────────────────────────────────────────────────────

/**
 * Resolves a single URL attribute value to an absolute path.
 * Returns null for URLs that should not be rewritten (external, anchors, data:, etc.).
 */
function resolveUrl(url, base, prefix, slug) {
  if (!url || url.startsWith('#') || url.startsWith('//') ||
      /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return null;
  }
  if (url.startsWith('/')) {
    // Root-relative: rebase under /{prefix}/{slug}/
    return `/${prefix}/${slug}${url}`;
  }
  // Relative: resolve against the file's absolute base path
  try {
    const resolved = new URL(url, `http://x${base}`);
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return null;
  }
}

/**
 * Rewrites all href/src/action URLs in the HTML to absolute paths.
 * Runs BEFORE any marketplace assets are injected so injected absolute
 * URLs (e.g. /__wf/knowledge-base/style.css) are never double-rewritten.
 * Removes any pre-existing <base> tag.
 *
 * @param {string} html
 * @param {string} prefix  - e.g. 'knowledge-base'
 * @param {string} slug    - app slug, e.g. 'my-app'
 * @param {string} fileRelDir - path of the HTML file relative to the app root,
 *                              e.g. '' for index.html, 'getting-started' for
 *                              getting-started/index.html
 */
function rewriteUrlsToAbsolute(html, prefix, slug, fileRelDir) {
  const base = `/${prefix}/${slug}/${fileRelDir ? fileRelDir + '/' : ''}`;

  // Remove any <base> tag — all URLs are now explicit
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Double-quoted attributes
  html = html.replace(
    /((?:href|src|action)\s*=\s*")([^"]*?)(")/gi,
    (match, pre, url, post) => {
      const abs = resolveUrl(url, base, prefix, slug);
      return abs !== null ? `${pre}${abs}${post}` : match;
    },
  );

  // Single-quoted attributes
  html = html.replace(
    /((?:href|src|action)\s*=\s*')([^']*?)(')/gi,
    (match, pre, url, post) => {
      const abs = resolveUrl(url, base, prefix, slug);
      return abs !== null ? `${pre}${abs}${post}` : match;
    },
  );

  return html;
}

// ── Sub-app HTML transformation ───────────────────────────────────────────────

const FONT_PRECONNECT = `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400;0,14..32,500;0,14..32,600;0,14..32,700&display=swap" rel="stylesheet">`;

/**
 * Transforms raw sub-app HTML for embedding in the marketplace.
 *
 * Steps (all applied in order):
 *  1. Rewrite all relative/root-relative URLs to absolute /knowledge-base/slug/… paths
 *  2. Add data-astro-transition-persist to all stylesheet links (prevents FOUC)
 *  3. Inject marketplace CSS link (via /__wf/ gateway route)
 *  4. Inject Google Fonts preconnect if Inter is not already loaded
 *  5a. Headless: strip dark-mode, mark document, inject shadow DOM compat styles
 *  5b. Non-headless: inject chrome bar and SPA router
 *
 * @param {string}   html
 * @param {Array}    apps       - full apps.json array (for chrome nav)
 * @param {string}   slug       - this app's slug
 * @param {string}   fileRelDir - path of this HTML file relative to the app root
 * @param {string}   prefix     - URL prefix, e.g. 'knowledge-base'
 * @param {boolean}  headless   - whether to render in headless (fragment) mode
 */
export function transformSubAppHtml(html, apps, slug, fileRelDir, prefix, headless) {
  // 1. Rewrite all URLs to absolute /knowledge-base/slug/... (must be first)
  html = rewriteUrlsToAbsolute(html, prefix, slug, fileRelDir);

  // 2. Add data-astro-transition-persist to every stylesheet <link> so that
  //    Astro's ClientRouter keeps them in place across page transitions (no FOUC).
  //    Strip any trailing self-closing slash from attrs before re-serialising.
  html = html.replace(
    /<link(\s[^>]*rel\s*=\s*["']stylesheet["'][^>]*)>/gi,
    (match, attrs) => {
      if (attrs.includes('data-astro-transition-persist')) return match;
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch) return match;
      const id = 'css-' + hrefMatch[1].replace(/[^a-z0-9]/gi, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
      const cleanAttrs = attrs.replace(/\s*\/\s*$/, ''); // drop trailing / from self-closing tags
      return `<link${cleanAttrs} data-astro-transition-persist="${id}">`;
    },
  );

  // 3. Inject marketplace CSS via /__wf/ gateway route
  const stylePath = `/__wf/${prefix}/style.css`;
  if (!html.includes(`href="${stylePath}"`)) {
    html = html.replace(/<\/head>/i, `  <link rel="stylesheet" href="${stylePath}" data-astro-transition-persist="css-wf-${prefix}-style-css">\n</head>`);
  }

  // 4. Inject font preconnect if Inter isn't loaded
  if (!html.includes('fonts.googleapis.com')) {
    const fontsPersist = FONT_PRECONNECT.replace(
      /rel="stylesheet"/,
      'rel="stylesheet" data-astro-transition-persist="css-google-fonts-inter"',
    );
    html = html.replace(/<\/head>/i, `  ${fontsPersist}\n</head>`);
  }

  if (headless) {
    // H-a. Force light mode: remove `dark` class and localStorage theme script
    html = html.replace(
      /(<html\b[^>]*)\bclass=(["'])([^"']*)\2([^>]*>)/i,
      (_, pre, q, cls, post) => {
        const cleaned = cls.replace(/\bdark\b/g, '').replace(/\s+/g, ' ').trim();
        const classAttr = cleaned ? ` class=${q}${cleaned}${q}` : '';
        return `${pre.trimEnd()}${classAttr}${post}`;
      },
    );
    html = html.replace(/<script>[^<]*localStorage[^<]*classList[^<]*<\/script>\s*/gi, '');

    // H-b. Mark document as headless
    html = html.replace(/(<html\b[^>]*)(>)/i, (_, openTag, gt) => {
      if (openTag.includes('data-mp-headless')) return `${openTag}${gt}`;
      return `${openTag} data-mp-headless="true"${gt}`;
    });

    // H-c. Inject shadow DOM compat styles before </body>
    html = html.replace(/<\/body>/i, `${shadowCompatStyle}\n</body>`);

    return html;
  }

  // Non-headless: inject full chrome bar
  if (!html.includes('mp-theme')) {
    html = html.replace(/<\/head>/i, `  ${chromeScript}\n</head>`);
  }
  if (!html.includes('data-mp-router')) {
    html = html.replace(/<\/head>/i, `  ${marketplaceRouterScript(prefix)}\n</head>`);
  }

  const chrome = chromeHtml(apps, slug, './', prefix);
  html = html.replace(
    /(<body\b[^>]*)(>)/i,
    (_, openTag, gt) => {
      openTag = /class=["']/.test(openTag)
        ? openTag.replace(/class=(["'])/, 'class=$1mp-wrapped ')
        : `${openTag} class="mp-wrapped"`;
      return `${openTag}${gt}\n\n${chrome}\n`;
    },
  );

  return html;
}

