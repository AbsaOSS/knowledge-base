// src/utils/transform.js
//
// Pure sub-app HTML transformation utilities for the Astro catchall page.
//
// Packaged sub-app pages arrive as complete pre-built documents. Rather than
// emitting them verbatim, the catchall route renders them through Base.astro so
// the layout owns the masthead, fonts, marketplace CSS and <ClientRouter /> for
// every page. This module rewrites the sub-app URLs and splits the document into
// the parts the layout needs.
//
// WHY A PARSER AND NOT REGEXES
//
// The input is third-party HTML from another repository's release artifact, so
// every "surely no document does that" assumption a regex makes eventually meets
// a document that does. Pattern matching got this wrong four ways (#48):
// a `</body>` inside a script truncated the page, a `<` inside the theme
// bootstrap defeated the strip that keeps the marketplace light-only, several
// URL-bearing attributes were never rewritten, and `href="/x"` inside a code
// sample in the prose was rewritten as if it were a link. parse5 is the same
// tokenizer a browser uses, it is build-time only, and it knows the difference
// between an attribute, a comment and a text node — so all four stop being
// possible rather than being patched one at a time.

import { parse, serialize } from 'parse5';

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

/** Attributes holding exactly one URL. `data` is handled separately — it is only a URL on <object>. */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster']);

/** Attributes holding a comma-separated candidate list (`url 2x, url 640w`). */
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);

/** <meta> property/name values whose `content` is a URL. */
const URL_META = new Set([
  'og:image', 'og:image:url', 'og:image:secure_url', 'og:url',
  'twitter:image', 'twitter:image:src',
]);

/** Rewrites every `url(...)` reference in a CSS string (inline `style=` or a <style> block). */
function rewriteCssUrls(css, base, prefix, slug) {
  return css.replace(
    /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
    (match, quote, url) => {
      const abs = resolveUrl(url.trim(), base, prefix, slug);
      return abs === null ? match : `url(${quote}${abs}${quote})`;
    },
  );
}

/**
 * Rewrites a `srcset` value candidate by candidate, preserving the descriptors.
 * A value containing a `data:` URI is left alone: commas inside the payload make
 * splitting ambiguous, and data: URIs need no rewriting anyway.
 */
function rewriteSrcset(value, base, prefix, slug) {
  if (/data:/i.test(value)) return value;
  return value
    .split(',')
    .map((candidate) => {
      const match = candidate.match(/^(\s*)(\S+)(\s*.*)$/s);
      if (!match) return candidate;
      const [, lead, url, descriptor] = match;
      const abs = resolveUrl(url, base, prefix, slug);
      return abs === null ? candidate : `${lead}${abs}${descriptor}`;
    })
    .join(',');
}

// ── Tree helpers ──────────────────────────────────────────────────────────────

const attrOf = (el, name) => el?.attrs?.find((a) => a.name === name);
const attrValue = (el, name) => attrOf(el, name)?.value;

/** Depth-first walk over every element in the tree, including <template> content. */
function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) {
      yield child;
      if (child.content) yield* elements(child.content);
    }
    yield* elements(child);
  }
}

/** Concatenated text of a node's direct text children (what <script>/<title> hold). */
function textOf(node) {
  return (node.childNodes ?? [])
    .filter((c) => c.nodeName === '#text')
    .map((c) => c.value)
    .join('');
}

function detach(node) {
  const siblings = node.parentNode?.childNodes;
  const index = siblings?.indexOf(node) ?? -1;
  if (index >= 0) siblings.splice(index, 1);
}

const childElement = (node, tagName) =>
  (node?.childNodes ?? []).find((c) => c.tagName === tagName);

// ── Light-only enforcement ────────────────────────────────────────────────────

/**
 * True when a script body is a sub-app's own dark-mode bootstrap.
 *
 * Exported because the strip has to happen in two places: here for the `astro
 * dev` path, and in scripts/hoist-inline-scripts.js for the build, which turns
 * inline scripts into files before this module ever sees the document — a
 * hoisted bootstrap would otherwise sail past the strip and re-add `dark` at
 * runtime, which is exactly the leak the light-only rule exists to prevent.
 */
export function isThemeBootstrap(code) {
  return /\blocalStorage\b/.test(code) &&
         /\bclassList\b/.test(code) &&
         /\bdark\b|\btheme\b/i.test(code);
}

// ── Sub-app HTML transformation ───────────────────────────────────────────────

/**
 * Rewrites a packaged sub-app document and splits it into the parts Base.astro
 * needs to re-host it.
 *
 * Steps (in order):
 *  1. Rewrite every URL-bearing attribute to an absolute /{prefix}/{slug}/… path
 *     and drop any <base> tag
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
  const base = `/${prefix}/${slug}/${fileRelDir ? fileRelDir + '/' : ''}`;

  // parse() always yields html > head + body, so a document that ships no
  // explicit <body> is split the same way a browser would split it — no
  // "body-only fragment" special case, and no first-`</body>`-wins truncation.
  const document = parse(html);
  const root = childElement(document, 'html');
  const head = childElement(root, 'head');
  const body = childElement(root, 'body');

  const doomed = [];

  for (const el of elements(root ?? document)) {
    // 1. URLs. Only attributes of real elements are touched, so a `href="/x"`
    //    written out in a code sample stays the string the author typed.
    if (el.tagName === 'base') { doomed.push(el); continue; }

    for (const attr of el.attrs ?? []) {
      if (URL_ATTRS.has(attr.name) || (attr.name === 'data' && el.tagName === 'object')) {
        const abs = resolveUrl(attr.value, base, prefix, slug);
        if (abs !== null) attr.value = abs;
      } else if (SRCSET_ATTRS.has(attr.name)) {
        attr.value = rewriteSrcset(attr.value, base, prefix, slug);
      } else if (attr.name === 'style') {
        attr.value = rewriteCssUrls(attr.value, base, prefix, slug);
      } else if (attr.name === 'content' && el.tagName === 'meta') {
        const key = (attrValue(el, 'property') ?? attrValue(el, 'name') ?? '').toLowerCase();
        if (URL_META.has(key)) {
          const abs = resolveUrl(attr.value, base, prefix, slug);
          if (abs !== null) attr.value = abs;
        }
      }
    }

    if (el.tagName === 'style') {
      for (const text of el.childNodes ?? []) {
        if (text.nodeName === '#text') text.value = rewriteCssUrls(text.value, base, prefix, slug);
      }
    }

    // 2. Keep stylesheets in place across ClientRouter navigation. Inside
    //    web-fragments, reframed relocates head nodes out of wf-head, so Astro's
    //    cleanup can no longer find them and they accumulate unbounded — see
    //    web-fragments issue #297.
    if (el.tagName === 'link' && /\bstylesheet\b/i.test(attrValue(el, 'rel') ?? '')) {
      const href = attrValue(el, 'href');
      if (href && !attrOf(el, 'data-astro-transition-persist')) {
        const id = 'css-' + href.replace(/[^a-z0-9]/gi, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
        el.attrs.push({ name: 'data-astro-transition-persist', value: id });
      }
    }

    // 6a. Light-only marketplace: the sub-app's theme bootstrap never runs.
    if (el.tagName === 'script' && !attrOf(el, 'src') && isThemeBootstrap(textOf(el))) {
      doomed.push(el);
      continue;
    }

    // 5. Base.astro already declares both; a second <meta charset> is ignored anyway.
    if (el.tagName === 'meta' &&
        (attrOf(el, 'charset') || (attrValue(el, 'name') ?? '').toLowerCase() === 'viewport')) {
      doomed.push(el);
    }
  }

  // 4. The layout renders <title> from the manifest title or this one.
  let title = null;
  const titleEl = childElement(head, 'title');
  if (titleEl) {
    title = textOf(titleEl).replace(/\s+/g, ' ').trim() || null;
    doomed.push(titleEl);
  }

  for (const el of doomed) detach(el);

  const bodyClass = (attrValue(body, 'class') ?? '')
    .replace(/\bdark\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    headHtml: head ? serialize(head).trim() : '',
    bodyHtml: body ? serialize(body) : '',
    bodyClass,
    title,
  };
}
