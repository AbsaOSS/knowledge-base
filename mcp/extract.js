import { parse } from 'parse5';

const DROP = new Set('script style noscript template svg canvas iframe object embed nav aside form button input select textarea dialog link meta'.split(' '));
const BLOCK = new Set('p div section blockquote dl dt dd figure figcaption'.split(' '));
const HIDDEN_CLASSES = new Set('kb-anchor headerlink md-sidebar sidebar toc'.split(' '));
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;
const clean = (value) => String(value ?? '').normalize('NFC').replace(CONTROL, '').replace(/[\t \f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
const tag = (node) => node.tagName?.toLowerCase();
const textOnly = (node) => clean((node.childNodes ?? []).map((child) => child.nodeName === '#text' ? child.value : textOnly(child)).join(' '));
function find(node, predicate) { if (predicate(node)) return node; for (const child of node.childNodes ?? []) { const found = find(child, predicate); if (found) return found; } return null; }
function hasDroppedClass(node) { return (attr(node, 'class') ?? '').split(/\s+/).some((part) => HIDDEN_CLASSES.has(part)); }
function unsafe(node, root) { const name = tag(node); return DROP.has(name) || ((name === 'header' || name === 'footer') && node !== root) || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true' || hasDroppedClass(node); }

/** Turn untrusted artifact HTML into bounded markdown-like plain text. */
export function extractDocument(html, { fallbackTitle = '', pageTitle = '', description = '', warn = () => {} } = {}) {
  const document = parse(html);
  const root = find(document, (node) => tag(node) === 'main') ?? find(document, (node) => attr(node, 'role') === 'main') ?? find(document, (node) => tag(node) === 'article') ?? find(document, (node) => tag(node) === 'body') ?? document;
  const titleNode = find(root, (node) => tag(node) === 'h1');
  const documentTitle = find(document, (node) => tag(node) === 'title');
  const sections = [], paragraphs = [];
  let output = '';
  const add = (value, gap = '') => { const valueClean = clean(value); if (!valueClean) return; if (output && gap) output += gap; output += valueClean; };
  const inline = (node) => {
    if (node.nodeName === '#text') return node.value ?? '';
    if (unsafe(node, root)) return '';
    const name = tag(node);
    if (name === 'br') return '\n';
    if (name === 'img') return attr(node, 'alt') ? `[${attr(node, 'alt')}]` : '';
    const value = (node.childNodes ?? []).map(inline).join('');
    return name === 'code' ? `\`${value}\`` : value;
  };
  const render = (node, depth = 0) => {
    if (node.nodeName === '#text') { add(node.value); return; }
    if (unsafe(node, root)) return;
    const name = tag(node);
    if (!name) { for (const child of node.childNodes ?? []) render(child, depth); return; }
    if (/^h[1-6]$/.test(name)) {
      const heading = clean(inline(node)); if (!heading) return;
      if (output) output += '\n\n'; const start = output.length;
      output += `${'#'.repeat(Number(name[1]))} ${heading}`;
      sections.push({ heading, anchor: /^[A-Za-z][\w:.-]{0,127}$/.test(attr(node, 'id') ?? '') ? attr(node, 'id') : null, level: Number(name[1]), start }); return;
    }
    if (name === 'img') { add(attr(node, 'alt') ? `[${attr(node, 'alt')}]` : '', '\n\n'); return; }
    if (name === 'pre') { const classes = attr(node, 'class') ?? ''; const lang = classes.includes('mermaid') ? 'mermaid' : classes.match(/(?:^|\s)language-([a-z0-9+#-]{1,20})(?:\s|$)/i)?.[1] ?? ''; add(`\`\`\`${lang}\n${textOnly(node)}\n\`\`\``, '\n\n'); return; }
    if (name === 'table') { for (const row of node.childNodes ?? []) if (tag(row) === 'tbody' || tag(row) === 'thead' || tag(row) === 'tfoot') render(row, depth); else if (tag(row) === 'tr') { const cells = (row.childNodes ?? []).filter((cell) => ['td', 'th'].includes(tag(cell))).map(textOnly); add(`| ${cells.join(' | ')} |`, '\n'); } return; }
    if (name === 'tr') { const cells = (node.childNodes ?? []).filter((cell) => ['td', 'th'].includes(tag(cell))).map(textOnly); add(`| ${cells.join(' | ')} |`, '\n'); return; }
    if (name === 'ul' || name === 'ol') { let i = 0; for (const child of node.childNodes ?? []) if (tag(child) === 'li') { i += 1; add(`${'  '.repeat(depth)}${name === 'ol' ? `${i}. ` : '- '}${clean(inline(child))}`, '\n'); } return; }
    if (name === 'li') return;
    if (BLOCK.has(name)) { const value = inline(node); if (value) { paragraphs.push(clean(value)); add(value, '\n\n'); } return; }
    for (const child of node.childNodes ?? []) render(child, depth);
  };
  render(root);
  let text = clean(output), truncated = false;
  if (text.length > 500000) { text = text.slice(0, 500000); truncated = true; warn('MCP extraction truncated document at 500000 characters'); }
  for (let i = 0; i < sections.length; i += 1) { sections[i].end = Math.min(text.length, i + 1 < sections.length ? sections[i + 1].start : text.length); }
  const title = clean(pageTitle || titleNode && textOnly(titleNode) || documentTitle && textOnly(documentTitle) || fallbackTitle).slice(0, 200);
  const extractedDescription = paragraphs.find((item) => item.length >= 40) ?? description;
  return { title, description: clean(extractedDescription).slice(0, 300), text, sections: sections.filter((section) => section.start < section.end), truncated };
}
