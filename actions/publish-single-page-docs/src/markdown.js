/**
 * markdown.js — GitHub-flavoured markdown → headless HTML.
 *
 * Rendering happens inside the action so an onboarding repo needs no toolchain
 * of its own: no mkdocs, no theme, no config file. What the repo commits is the
 * markdown; everything below turns it into a page the knowledge base can re-host.
 *
 * Covered by design: tables, task lists, autolinks, footnotes, strikethrough,
 * highlighted code fences and ```mermaid diagrams.
 */

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';

import { sanitizeDocHtml } from './sanitize.js';
import { escapeHtml } from './template.js';

/** Language aliases authors reach for that highlight.js does not know verbatim. */
const LANG_ALIASES = {
  sh: 'bash', shell: 'bash', console: 'bash', zsh: 'bash',
  yml: 'yaml', jsonc: 'json', tsx: 'typescript', jsx: 'javascript',
  psl: 'plaintext', text: 'plaintext', txt: 'plaintext',
};

/**
 * Builds the markdown renderer.
 *
 * `state` is mutated during a render so the caller can learn what the document
 * needs (currently: whether a mermaid diagram appeared, which decides if the
 * vendored mermaid bundle is written into the doc directory).
 */
function createRenderer(state) {
  const md = new MarkdownIt({
    // Authors may drop in raw HTML — GFM allows it. Everything this produces is
    // put through an allowlist in sanitize.js before it leaves the action: the
    // rendered doc is re-hosted on the knowledge base's own origin alongside
    // every other doc, so unsanitised markup from any onboarding repo would be
    // script execution against all of them.
    html: true,
    linkify: true,    // bare URLs become links (GFM autolinks)
    breaks: false,
    typographer: false,
  });

  md.use(footnote);
  md.use(taskLists, { label: true, labelAfter: true });
  md.use(anchor, {
    level: [1, 2, 3, 4],
    permalink: anchor.permalink.linkInsideHeader({
      symbol: '#',
      class: 'kb-anchor',
      placement: 'after',
    }),
  });

  // ── Fences: mermaid passthrough + highlight.js ─────────────────────────────
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = (token.info || '').trim().split(/\s+/)[0].toLowerCase();

    if (info === 'mermaid') {
      // Left as source; the vendored mermaid bundle swaps in an <svg> at runtime.
      // If the script never loads the reader still sees the diagram definition.
      state.usesMermaid = true;
      return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    }

    const lang = LANG_ALIASES[info] || info;
    let body;
    if (lang && hljs.getLanguage(lang)) {
      body = hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value;
    } else {
      body = escapeHtml(token.content);
    }
    const langClass = lang ? ` language-${escapeHtml(lang)}` : '';
    return `<pre class="kb-code"><code class="hljs${langClass}">${body}</code></pre>\n`;
  };

  // ── Tables scroll inside their own box rather than widening the page ───────
  md.renderer.rules.table_open  = () => '<div class="kb-table-wrap">\n<table>\n';
  md.renderer.rules.table_close = () => '</table>\n</div>\n';

  // ── External links open in a new tab, and never leak the referrer ──────────
  const defaultLinkOpen = md.renderer.rules.link_open
    || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}

/**
 * Renders one markdown source to HTML.
 *
 * @param {string} source - markdown text
 * @returns {{html: string, usesMermaid: boolean, hasHeading: boolean}}
 */
export function renderMarkdown(source) {
  const state = { usesMermaid: false };
  const md = createRenderer(state);
  const html = sanitizeDocHtml(md.render(source));
  return {
    html,
    usesMermaid: state.usesMermaid,
    // Whether the author already opens with a title — decides if the document
    // template synthesises a lede from the manifest title/description.
    hasHeading: /<h1\b/i.test(html),
  };
}
