/**
 * sanitize.js — allowlist sanitiser for rendered doc HTML.
 *
 * WHY
 *
 * The renderer runs markdown-it with `html: true`, because GitHub-flavoured
 * markdown lets authors drop in raw HTML and docs in the wild rely on it. The
 * output is then re-hosted by the knowledge base with `set:html`, on the
 * knowledge base's own origin, alongside every other doc.
 *
 * That makes the trust boundary every repository that onboards — and the blast
 * radius the whole knowledge base, since all docs share one origin. A `<script>`
 * or an `<img onerror>` in any repo's markdown would otherwise run against every
 * other doc's page. markdown-it's own `validateLink` blocks `javascript:` in
 * *markdown* links, but raw HTML bypasses it entirely.
 *
 * So raw HTML stays supported, but only the subset the doc stylesheet actually
 * renders survives. Anything else is dropped at publish time, in the action,
 * before it is ever packed into an artifact.
 *
 * WHAT SURVIVES
 *
 * The tags markdown-it emits for the features contract/SINGLE_PAGE.md promises
 * (tables, task lists, footnotes, anchors, highlighted code, mermaid), plus the
 * common structural and inline HTML an author might hand-write. Class and id
 * attributes are kept because the rendering pipeline depends on them —
 * `kb-code`, `kb-anchor`, `hljs-*`, `task-list-item`, `footnotes`, heading ids.
 */

import sanitizeHtml from 'sanitize-html';

/**
 * Attributes safe on any element.
 *
 * `class` and `id` carry no script; they are what the doc stylesheet, the anchor
 * plugin and highlight.js all key off. Event handlers (`on*`) are not listed
 * anywhere and sanitize-html drops unlisted attributes.
 */
const GLOBAL_ATTRIBUTES = ['class', 'id', 'title', 'dir', 'lang'];

const OPTIONS = {
  allowedTags: [
    // Structure
    'section', 'article', 'aside', 'div', 'p', 'br', 'hr', 'span',
    'details', 'summary', 'figure', 'figcaption', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    // Lists
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    // Tables
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    // Inline
    'a', 'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small',
    'sub', 'sup', 'abbr', 'cite', 'q', 'kbd', 'samp', 'var', 'time',
    // Code — `pre.mermaid` is how a diagram source reaches the vendored renderer
    'pre', 'code',
    // Media
    'img',
    // Task lists render a disabled checkbox followed by its label — without the
    // label the checkbox loses its accessible name and its click target.
    'input', 'label',
  ],

  allowedAttributes: {
    '*': GLOBAL_ATTRIBUTES,
    a: [...GLOBAL_ATTRIBUTES, 'href', 'name', 'target', 'rel'],
    img: [...GLOBAL_ATTRIBUTES, 'src', 'alt', 'width', 'height', 'loading', 'decoding'],
    // markdown-it-task-lists emits <input type="checkbox" disabled [checked]>.
    // No name/value: these are display-only, never submitted.
    input: [...GLOBAL_ATTRIBUTES, 'type', 'checked', 'disabled'],
    label: [...GLOBAL_ATTRIBUTES, 'for'],
    th: [...GLOBAL_ATTRIBUTES, 'colspan', 'rowspan', 'scope', 'align'],
    td: [...GLOBAL_ATTRIBUTES, 'colspan', 'rowspan', 'align'],
    ol: [...GLOBAL_ATTRIBUTES, 'start', 'reversed', 'type'],
    li: [...GLOBAL_ATTRIBUTES, 'value'],
    time: [...GLOBAL_ATTRIBUTES, 'datetime'],
    abbr: [...GLOBAL_ATTRIBUTES, 'title'],
    details: [...GLOBAL_ATTRIBUTES, 'open'],
    col: [...GLOBAL_ATTRIBUTES, 'span'],
    colgroup: [...GLOBAL_ATTRIBUTES, 'span'],
  },

  // No `style` attribute anywhere: it is the remaining injection surface once
  // scripts are gone (CSS can exfiltrate via url(), and it lets a doc break out
  // of its reading column and cover the masthead).
  allowedStyles: {},

  // `data:` is not here on purpose — a data: URI is an arbitrary document, and
  // an <img> is not worth that. `mailto:` and `tel:` are ordinary doc content.
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // A protocol-relative //evil.example URL inherits the page's scheme; treat it
  // as a URL needing an allowed scheme rather than a bare path.
  allowProtocolRelative: false,

  // Keep the text of a dropped tag — losing a paragraph because it was wrapped
  // in something unsupported is a worse failure than losing the wrapper.
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],

  transformTags: {
    // Re-assert what markdown.js sets on external links. An author writing raw
    // <a target="_blank"> without rel exposes the opener; sanitising is the last
    // place that can be guaranteed.
    a(tagName, attribs) {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      return { tagName, attribs };
    },
    // Task-list checkboxes are the only inputs markdown produces, and they are
    // always disabled. Anything else claiming to be an input is not a doc.
    input(tagName, attribs) {
      if (attribs.type !== 'checkbox') return { tagName: 'span', attribs: {} };
      return { tagName, attribs: { ...attribs, disabled: 'disabled' } };
    },
  },
};

/**
 * Strips everything outside the allowlist from rendered doc HTML.
 *
 * @param {string} html - output of the markdown renderer
 * @returns {string}
 */
export function sanitizeDocHtml(html) {
  return sanitizeHtml(html, OPTIONS);
}

/** Exported for the self-test, so the allowlist is asserted rather than described. */
export const SANITIZE_OPTIONS = OPTIONS;
