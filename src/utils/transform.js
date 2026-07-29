// src/utils/transform.js
//
// Pure sub-app HTML transformation utilities for the Astro catchall page.
//
// Packaged sub-app pages arrive as complete pre-built documents. Rather than
// emitting them verbatim, the catchall route renders them through Base.astro so
// the layout owns the masthead, fonts, marketplace CSS and <ClientRouter /> for
// every page. This module rewrites the sub-app URLs and splits the document into
// the parts the layout needs.

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

/**
 * Adds data-astro-transition-persist to every stylesheet <link> so Astro's
 * ClientRouter keeps them in place across page transitions instead of removing
 * and re-adding them. Inside web-fragments, reframed relocates head nodes out of
 * wf-head, so Astro's cleanup can no longer find them and they accumulate
 * unbounded — see web-fragments issue #297.
 */
function persistStylesheets(html) {
  return html.replace(
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
}

/** Strips a sub-app's own `localStorage` theme bootstrap — the marketplace is light-only. */
function stripThemeBootstrap(html) {
  return html.replace(/<script>[^<]*localStorage[^<]*classList[^<]*<\/script>\s*/gi, '');
}

// ── Sub-app HTML transformation ───────────────────────────────────────────────

/**
 * Rewrites a packaged sub-app document and splits it into the parts Base.astro
 * needs to re-host it.
 *
 * Steps (in order):
 *  1. Rewrite all relative/root-relative URLs to absolute /{prefix}/{slug}/… paths
 *  2. Stamp data-astro-transition-persist on every stylesheet link
 *  3. Split off <head> contents, <body> attributes and <body> contents
 *  4. Lift the <title> out of the head (the layout renders it)
 *  5. Drop <meta charset> / <meta viewport> duplicates (the layout provides both)
 *  6. Strip the sub-app's theme bootstrap and any `dark` body class — light only
 *
 * @param {string}   html
 * @param {string}   slug       - this app's slug
 * @param {string}   fileRelDir - path of this HTML file relative to the app root
 * @param {string}   prefix     - URL prefix, e.g. 'knowledge-base'
 * @returns {{headHtml: string, bodyHtml: string, bodyClass: string, title: string|null}}
 */
export function transformSubAppHtml(html, slug, fileRelDir, prefix) {
  html = rewriteUrlsToAbsolute(html, prefix, slug, fileRelDir);
  html = persistStylesheets(html);

  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = html.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);

  let headHtml = headMatch ? headMatch[1] : '';
  const bodyAttrs = bodyMatch ? bodyMatch[1] : '';
  // Documents without an explicit <body> are treated as body-only fragments.
  let bodyHtml = bodyMatch
    ? bodyMatch[2]
    : (headMatch ? html.replace(headMatch[0], '') : html);

  // The layout renders <title> from the manifest title or this one.
  let title = null;
  headHtml = headHtml.replace(/<title\b[^>]*>([\s\S]*?)<\/title>/i, (_, t) => {
    title = t.replace(/\s+/g, ' ').trim() || null;
    return '';
  });

  // Base.astro already declares both; a second <meta charset> is ignored anyway.
  headHtml = headHtml.replace(/<meta\b[^>]*\bcharset\b[^>]*>/gi, '');
  headHtml = headHtml.replace(/<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/gi, '');

  // Light-only marketplace: drop the sub-app's theme bootstrap and `dark` class.
  headHtml = stripThemeBootstrap(headHtml);
  bodyHtml = stripThemeBootstrap(bodyHtml);
  const bodyClass = (bodyAttrs.match(/class\s*=\s*["']([^"']*)["']/i)?.[1] ?? '')
    .replace(/\bdark\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { headHtml: headHtml.trim(), bodyHtml, bodyClass, title };
}
