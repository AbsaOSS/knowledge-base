// Turns untrusted artifact HTML into bounded, markdown-like plain text. Build time only:
// the server never parses HTML.
import { parse } from 'parse5';
import type { IndexedSection } from '../search-index/schema.ts';

/** The slice of parse5's default tree this walker reads. */
interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
}

export interface ExtractOptions {
  fallbackTitle?: string;
  /** A manifest-declared page title; wins over anything in the HTML. */
  pageTitle?: string;
  /** The app description, used when no paragraph is long enough to describe the page. */
  description?: string;
  warn?: (message: string) => void;
}

export interface ExtractedDocument {
  title: string;
  description: string;
  text: string;
  sections: IndexedSection[];
  truncated: boolean;
}

export const MAX_TEXT_LENGTH = 500_000;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 300;
const MIN_DESCRIPTION_LENGTH = 40;

const words = (list: string) => new Set(list.split(' '));

/** Never rendered, nor anything inside them. */
const DROP = words(
  'script style noscript template svg canvas iframe object embed nav aside form button input select textarea dialog link meta',
);
/** Elements that end an inline run. Everything else (text, a, strong, span, code, img…) joins the run around it. */
const BLOCK_LEVEL = words(
  'address article aside blockquote dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul',
);
/** Page chrome that docs generators mark with a class instead of an element. */
const HIDDEN_CLASSES = words('kb-anchor headerlink md-sidebar sidebar toc');
/** C0 controls, DEL, zero-width characters and bidi overrides/isolates. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const SAFE_ANCHOR = /^[A-Za-z][\w:.-]{0,127}$/;
const CODE_LANGUAGE = /(?:^|\s)language-([a-z0-9+#-]{1,20})(?:\s|$)/i;

const clean = (value: string | undefined): string =>
  (value ?? '')
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(/[\t \f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const oneLine = (value: string): string => clean(value).replace(/\n+/g, ' ');
const attr = (node: HtmlNode, name: string): string | undefined =>
  node.attrs?.find((item) => item.name === name)?.value;
const tag = (node: HtmlNode): string | undefined => node.tagName?.toLowerCase();
const children = (node: HtmlNode): HtmlNode[] => node.childNodes ?? [];
const rawText = (node: HtmlNode): string =>
  node.nodeName === '#text' ? (node.value ?? '') : children(node).map(rawText).join('');
const textOnly = (node: HtmlNode): string => clean(rawText(node));
const headingLevel = (name: string | undefined): number => (name && /^h[1-6]$/.test(name) ? Number(name[1]) : 0);

function find(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | null {
  if (predicate(node)) return node;
  for (const child of children(node)) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

const hasHiddenClass = (node: HtmlNode): boolean =>
  (attr(node, 'class') ?? '').split(/\s+/).some((part) => HIDDEN_CLASSES.has(part));

/** The page's main content: <main>, role=main, <article>, <body>, or the whole document. */
const contentRoot = (document: HtmlNode): HtmlNode =>
  find(document, (node) => tag(node) === 'main') ??
  find(document, (node) => attr(node, 'role') === 'main') ??
  find(document, (node) => tag(node) === 'article') ??
  find(document, (node) => tag(node) === 'body') ??
  document;

/** Walks one document. `output` grows as nodes render; sections record offsets into it. */
class Extractor {
  output = '';
  readonly sections: (Omit<IndexedSection, 'end'> & { end?: number })[] = [];
  readonly paragraphs: string[] = [];
  private readonly root: HtmlNode;

  constructor(root: HtmlNode) {
    this.root = root;
  }

  /** Dropped elements, hidden ones, and header/footer chrome other than the root itself. */
  private unsafe(node: HtmlNode): boolean {
    const name = tag(node);
    return (
      (name !== undefined && DROP.has(name)) ||
      ((name === 'header' || name === 'footer') && node !== this.root) ||
      attr(node, 'hidden') !== undefined ||
      attr(node, 'aria-hidden') === 'true' ||
      hasHiddenClass(node)
    );
  }

  private add(value: string, gap = ''): void {
    const cleaned = clean(value);
    if (!cleaned) return;
    if (this.output && gap) this.output += gap;
    this.output += cleaned;
  }

  private startBlock(): void {
    if (this.output) this.output += '\n\n';
  }

  private inline(node: HtmlNode): string {
    if (node.nodeName === '#text') return node.value ?? '';
    if (this.unsafe(node)) return '';
    const name = tag(node);
    if (name === 'br') return '\n';
    if (name === 'img') {
      const alt = attr(node, 'alt');
      return alt ? `[${alt}]` : '';
    }
    const value = children(node)
      .map((child) => this.inline(child))
      .join('');
    if (name === 'code') return `\`${value}\``;
    // A block nested where only inline text is wanted (a <p> in a list item or cell) still separates words.
    return name !== undefined && BLOCK_LEVEL.has(name) ? ` ${value} ` : value;
  }

  /** Render children, joining each run of adjacent inline nodes into one paragraph before trimming it. */
  private renderChildren(node: HtmlNode, depth: number): void {
    let run = '';
    const flush = () => {
      const value = clean(run);
      run = '';
      if (!value) return;
      this.paragraphs.push(value);
      this.add(value, '\n\n');
    };
    for (const child of children(node)) {
      const name = tag(child);
      if (name === undefined || !BLOCK_LEVEL.has(name)) {
        run += this.inline(child);
      } else {
        flush();
        this.render(child, depth);
      }
    }
    flush();
  }

  private renderList(node: HtmlNode, depth: number): void {
    const marker = tag(node) === 'ol' ? (i: number) => `${i}. ` : () => '- ';
    let i = 0;
    for (const item of children(node)) {
      if (tag(item) !== 'li' || this.unsafe(item)) continue;
      i += 1;
      const nested = children(item).filter((child) => ['ul', 'ol', 'pre', 'table'].includes(tag(child) ?? ''));
      const label = oneLine(
        children(item)
          .filter((child) => !nested.includes(child))
          .map((child) => this.inline(child))
          .join(''),
      );
      if (label) {
        // Appended as-is: add() would trim away the nesting indent.
        if (this.output) this.output += i === 1 && depth === 0 ? '\n\n' : '\n';
        this.output += `${'  '.repeat(depth)}${marker(i)}${label}`;
      }
      for (const child of nested) this.render(child, depth + 1);
    }
  }

  private renderHeading(node: HtmlNode, level: number): void {
    const heading = oneLine(this.inline(node));
    if (!heading) return;
    this.startBlock();
    const start = this.output.length;
    this.output += `${'#'.repeat(level)} ${heading}`;
    const id = attr(node, 'id') ?? '';
    this.sections.push({ heading, anchor: SAFE_ANCHOR.test(id) ? id : null, level, start });
  }

  /** Code keeps its whitespace: highlighter token spans are joined as-is and indentation survives. */
  private renderCode(node: HtmlNode): void {
    const classes = attr(node, 'class') ?? '';
    const language = classes.includes('mermaid') ? 'mermaid' : (CODE_LANGUAGE.exec(classes)?.[1] ?? '');
    const code = rawText(node)
      .normalize('NFC')
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL, '')
      .replace(/^\n+|\s+$/g, '');
    if (!code) return;
    this.startBlock();
    this.output += `\`\`\`${language}\n${code}\n\`\`\``;
  }

  private renderTable(node: HtmlNode): void {
    const rows = children(node)
      .flatMap((child) => (['thead', 'tbody', 'tfoot'].includes(tag(child) ?? '') ? children(child) : [child]))
      .filter((row) => tag(row) === 'tr' && !this.unsafe(row));
    const lines = rows.map((row) => {
      const cells = children(row)
        .filter((cell) => ['td', 'th'].includes(tag(cell) ?? ''))
        .map((cell) => oneLine(this.inline(cell)));
      return `| ${cells.join(' | ')} |`;
    });
    this.add(lines.join('\n'), '\n\n');
  }

  render(node: HtmlNode, depth = 0): void {
    if (this.unsafe(node)) return;
    const name = tag(node);
    const level = headingLevel(name);
    if (level) this.renderHeading(node, level);
    else if (name === 'pre') this.renderCode(node);
    else if (name === 'table') this.renderTable(node);
    else if (name === 'ul' || name === 'ol') this.renderList(node, depth);
    else if (name !== 'hr') this.renderChildren(node, depth);
  }
}

/** Turn untrusted artifact HTML into bounded markdown-like plain text. */
export function extractDocument(html: string, options: ExtractOptions = {}): ExtractedDocument {
  const { fallbackTitle = '', pageTitle = '', description = '', warn = () => undefined } = options;
  const document = parse(html) as unknown as HtmlNode;
  const root = contentRoot(document);
  const extractor = new Extractor(root);
  extractor.render(root);

  let text = extractor.output;
  let truncated = false;
  if (text.length > MAX_TEXT_LENGTH) {
    text = text.slice(0, MAX_TEXT_LENGTH);
    truncated = true;
    warn(`MCP extraction truncated document at ${MAX_TEXT_LENGTH} characters`);
  }

  // Each section runs to the next heading, or to the end of the (possibly truncated) text.
  const sections = extractor.sections.map((section, i, all) => ({
    ...section,
    end: Math.min(text.length, all[i + 1]?.start ?? text.length),
  }));

  const titleNode = find(root, (node) => tag(node) === 'h1');
  const documentTitle = find(document, (node) => tag(node) === 'title');
  const title = clean(
    pageTitle ||
      (titleNode ? textOnly(titleNode) : '') ||
      (documentTitle ? textOnly(documentTitle) : '') ||
      fallbackTitle,
  ).slice(0, MAX_TITLE_LENGTH);
  const extractedDescription =
    extractor.paragraphs.find((paragraph) => paragraph.length >= MIN_DESCRIPTION_LENGTH) ?? description;

  return {
    title,
    description: clean(extractedDescription).slice(0, MAX_DESCRIPTION_LENGTH),
    text,
    sections: sections.filter((section) => section.start < section.end),
    truncated,
  };
}
