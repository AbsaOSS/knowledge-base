/**
 * check.js — checks a built docs site against the contract, rule by rule.
 *
 * Runs in the publishing repo: at publish time inside the publish-docs action,
 * on pull requests inside the check-docs action, and on demand through
 * check-cli.js (a local build, or an agent fixing the repo). That is the only place anyone can act on a finding. The knowledge base
 * build repairs some of the same things when it re-hosts a page — it hoists
 * inline scripts, strips a theme bootstrap, absolutises CSS URLs — but by then
 * the artifact is released and the person who can fix it has moved on.
 *
 * Each rule is defined in rules.js and explained in contract/RULES.md. Every
 * finding is collected and reported together, each naming its rule and file.
 *
 * HTML is parsed (htmlparser2) and CSS is parsed (postcss) rather than pattern
 * matched, so markup quoted in prose or inside a script is never mistaken for
 * the real thing. JavaScript is not parsed: KB-JS-001 is a textual heuristic,
 * which is why it is a warning.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { parseDocument } from 'htmlparser2';
import postcss from 'postcss';

import { isThemeBootstrap } from '../../src/utils/theme.js';
import { PublishError, readManifestFile } from './manifest.js';
import { RULES_DOC, finding, formatFinding } from './rules.js';

/** The marker the knowledge base looks for on `<html>`. */
export const HEADLESS_MARKER = 'data-kb-headless="true"';
/** Its pre-v1 spelling, worth naming explicitly when we see it. */
const LEGACY_MARKER = 'data-mp-headless';

/** Attributes holding one URL — the set the knowledge base rewrites. */
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'poster'];

/** Script types a browser executes. Anything else (JSON, templates) is data. */
const EXECUTABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript']);

/** Pages a link may point at without leaving the fragment's document routing. */
const PAGE_EXTENSIONS = new Set(['html', 'htm']);

/** `https://…`, `http://…` or `//…` — another origin as far as the CSP is concerned. */
const isCrossOrigin = (url) => /^(?:https?:)?\/\//i.test(url.trim());
/** Has a scheme (`mailto:`, `data:`, `https:` …). */
const hasScheme = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url.trim());

/** Every file with one of the extensions under a directory. Symlinks are skipped. */
function filesWithExt(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesWithExt(full, exts, acc);
    else if (exts.some((ext) => entry.name.endsWith(ext))) acc.push(full);
  }
  return acc;
}

/** Every .html file under a directory. Symlinks are skipped. */
export const htmlFiles = (dir) => filesWithExt(dir, ['.html']);

/** Depth-first walk over every element. */
function* elements(node) {
  for (const child of node.children ?? []) {
    if (child.type === 'tag' || child.type === 'script' || child.type === 'style') {
      yield child;
      yield* elements(child);
    }
  }
}

const textOf = (el) => (el.children ?? []).map((c) => c.data ?? '').join('');
const classes = (el) => (el?.attribs?.class ?? '').split(/\s+/).filter(Boolean);
const quoteFirst = (list) => `"${list[0]}"`;

/**
 * Findings for one stylesheet — a file or an inline <style> block.
 * Unparseable CSS is left to the browser: it is not a contract matter.
 */
function checkCss(css, where) {
  let root;
  try {
    root = postcss.parse(css);
  } catch {
    return [];
  }
  const out = [];

  let important = 0;
  root.walkDecls((decl) => { if (decl.important) important++; });
  if (important > 0) {
    out.push(finding('KB-CSS-001', where,
      `${important} !important declaration(s). They outrank the knowledge base's own rules, so a ` +
      `leaked one can restyle the masthead or the catalog. Raise specificity instead.`));
  }

  const external = [];
  root.walkAtRules('import', (rule) => {
    const url = rule.params.match(/^(?:url\(\s*)?['"]?([^'")\s]+)/i)?.[1] ?? '';
    if (isCrossOrigin(url)) external.push(url);
  });
  root.walkAtRules('font-face', (rule) => {
    rule.walkDecls('src', (decl) => {
      for (const m of decl.value.matchAll(/url\(\s*['"]?([^'")]+)/gi)) {
        if (isCrossOrigin(m[1])) external.push(m[1]);
      }
    });
  });
  if (external.length > 0) {
    out.push(finding('KB-CSP-001', where,
      `${external.length} stylesheet or font URL(s) on another origin, e.g. ${quoteFirst(external)}. ` +
      `The knowledge base only loads styles and fonts from itself; ship them with the site.`));
  }
  return out;
}

/**
 * Findings for one script — a file or an inline block. A literal page-relative
 * URL handed to fetch() or XMLHttpRequest resolves against the host page once
 * embedded, not against this app.
 */
function checkJs(js, where) {
  const relativeUrls = [
    // The literal must be the whole argument: `"function"==typeof e ? … : e`
    // in a minified bundle starts with a string too.
    ...js.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`\s]+)\1\s*[,)]/g),
    ...js.matchAll(/\.open\s*\(\s*['"][A-Za-z]+['"]\s*,\s*(['"`])([^'"`\s]+)\1\s*[,)]/g),
  ]
    .map((m) => m[2])
    .filter((url) => !hasScheme(url) && !url.startsWith('/') && !url.startsWith('#') && !url.includes('${'));
  if (relativeUrls.length === 0) return [];
  return [finding('KB-JS-001', where,
    `${relativeUrls.length} fetch of a page-relative URL, e.g. ${quoteFirst(relativeUrls)}. Embedded, it ` +
    `resolves against the host page's URL. Resolve it against the script instead: ` +
    `new URL(url, import.meta.url) or document.currentScript.src.`)];
}

/** Findings for one HTML page. */
function checkHtml(html, where) {
  const out = [];
  const doc = parseDocument(html);
  const all = [...elements(doc)];
  const root = all.find((el) => el.name === 'html');
  const body = all.find((el) => el.name === 'body');

  if (root?.attribs?.['data-kb-headless'] !== 'true') {
    out.push(finding('KB-HTML-001', where, root && LEGACY_MARKER in root.attribs
      ? `carries ${LEGACY_MARKER}, the pre-v1 marker. Emit ${HEADLESS_MARKER} instead.`
      : `missing ${HEADLESS_MARKER} on <html>. Build with your headless flag.`));
  }

  if (all.some((el) => el.name === 'base')) {
    out.push(finding('KB-HTML-002', where,
      'contains a <base> element, which re-resolves every URL once the page is re-hosted.'));
  }

  const rootRelative = [];
  const scriptUrls = [];
  const handlers = [];
  const nonPageLinks = [];
  const external = [];
  let inline = 0;
  let themeScript = false;

  for (const el of all) {
    const attrs = el.attribs ?? {};

    // Root-relative URLs are authored for the app's own site root, but the app
    // is served from /knowledge-base/{slug}/. //host and /favicon are left
    // alone, matching the knowledge base's own rewrite.
    for (const name of URL_ATTRS) {
      const value = attrs[name]?.trim();
      if (value === undefined || el.name === 'base') continue;
      if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/favicon')) rootRelative.push(value);
      if (/^javascript:/i.test(value)) scriptUrls.push(`<${el.name} ${name}>`);
    }

    for (const name of Object.keys(attrs)) {
      if (/^on[a-z]+$/i.test(name)) handlers.push(`<${el.name} ${name}>`);
    }

    if (el.name === 'a' && attrs.href !== undefined) {
      const href = attrs.href.trim();
      if (href && !href.startsWith('#') && !href.startsWith('/') && !hasScheme(href)) {
        const path = href.split(/[?#]/)[0];
        const last = path.split('/').pop();
        const ext = last.includes('.') ? last.split('.').pop().toLowerCase() : '';
        if (ext && !PAGE_EXTENSIONS.has(ext)) nonPageLinks.push(href);
      }
    }

    if (el.name === 'script') {
      if (attrs.src !== undefined) {
        if (isCrossOrigin(attrs.src)) external.push(attrs.src);
      } else if (EXECUTABLE_TYPES.has((attrs.type ?? '').trim().toLowerCase())) {
        const code = textOf(el);
        if (code.trim() !== '') {
          inline++;
          if (isThemeBootstrap(code)) themeScript = true;
          out.push(...checkJs(code, `${where} (inline script)`));
        }
      }
    }

    if (el.name === 'link' && attrs.href !== undefined && isCrossOrigin(attrs.href)) {
      const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/);
      const as = (attrs.as ?? '').toLowerCase();
      if (rel.includes('stylesheet') || (rel.some((r) => r === 'preload' || r === 'modulepreload') && ['script', 'style', 'font', ''].includes(as))) {
        external.push(attrs.href);
      }
    }

    if (el.name === 'style') out.push(...checkCss(textOf(el), `${where} (inline style)`));
  }

  if (rootRelative.length > 0) {
    out.push(finding('KB-HTML-003', where,
      `${rootRelative.length} root-relative URL(s), e.g. ${quoteFirst(rootRelative)}. ` +
      `Paths must be relative — the app is mounted under /knowledge-base/{slug}/.`));
  }
  if (inline > 0) {
    out.push(finding('KB-HTML-004', where,
      `${inline} inline <script> block(s). The knowledge base will hoist them into files so it can ` +
      `serve script-src 'self'; ship them as files to keep control of that.`));
  }
  if (handlers.length > 0) {
    out.push(finding('KB-HTML-005', where,
      `${handlers.length} inline event handler(s), e.g. ${handlers[0]}. The knowledge base serves ` +
      `script-src 'self', so they never run. Attach listeners from a script file.`));
  }
  if (scriptUrls.length > 0) {
    out.push(finding('KB-HTML-006', where,
      `${scriptUrls.length} javascript: URL(s), e.g. ${scriptUrls[0]}. Blocked by the knowledge base's ` +
      `script-src 'self'. Use a button and a listener from a script file.`));
  }
  const header = all.find((el) => el.name === 'header' && el.parent === body);
  if (body && header) {
    out.push(finding('KB-HTML-007', where,
      'has a <header> directly inside <body>. The knowledge base masthead is the only site-level ' +
      'header; leave yours out of the headless build.'));
  }
  if (nonPageLinks.length > 0) {
    out.push(finding('KB-HTML-008', where,
      `${nonPageLinks.length} link(s) to a non-HTML file, e.g. ${quoteFirst(nonPageLinks)}. Embedded, ` +
      `following one loads the host application instead of the file. Link to a page that embeds it, ` +
      `or host the file outside the docs.`));
  }
  if (themeScript || classes(root).includes('dark') || classes(body).includes('dark')) {
    out.push(finding('KB-THEME-001', where,
      'ships dark mode (a theme bootstrap script or a "dark" class). The knowledge base is light only ' +
      'and strips both; leave them out of the headless build.'));
  }
  if (external.length > 0) {
    out.push(finding('KB-CSP-001', where,
      `${external.length} script or stylesheet URL(s) on another origin, e.g. ${quoteFirst(external)}. ` +
      `The knowledge base only loads scripts and styles from itself; ship them with the site.`));
  }
  return out;
}

/**
 * Checks one app's built output.
 *
 * @param {string} appDir - directory that becomes `<slug>/` in the artifact
 * @param {object} app    - the app's manifest entry
 * @returns {Array<{id: string, severity: string, where: string, message: string}>}
 */
export function checkApp(appDir, app) {
  const out = [];
  const rel = (file) => `${app.slug}/${relative(appDir, file).replace(/\\/g, '/')}`;

  const entryPoint = app.entryPoint ?? 'index.html';
  if (!existsSync(join(appDir, entryPoint))) {
    out.push(finding('KB-ART-001', app.slug,
      `entryPoint "${entryPoint}" does not exist in the built output. ` +
      `Check the action's "dist" input points at your build directory.`));
  }

  for (const page of app.pages ?? []) {
    if (!existsSync(join(appDir, page.path))) {
      out.push(finding('KB-ART-002', app.slug,
        `pages entry "${page.title}" points at "${page.path}", which is not in the built output.`));
    }
  }

  const pages = htmlFiles(appDir);
  if (pages.length === 0) {
    out.push(finding('KB-ART-003', app.slug, 'the built output contains no HTML at all.'));
    return out;
  }

  for (const file of pages) out.push(...checkHtml(readFileSync(file, 'utf8'), rel(file)));
  for (const file of filesWithExt(appDir, ['.css'])) out.push(...checkCss(readFileSync(file, 'utf8'), rel(file)));
  for (const file of filesWithExt(appDir, ['.js', '.mjs'])) out.push(...checkJs(readFileSync(file, 'utf8'), rel(file)));
  return out;
}

/**
 * Resolves an app's built output inside the `dist` input.
 *
 * One app is the common case, and then `dist` *is* that app's directory — a repo
 * publishing a single site should not have to invent a subdirectory named after
 * its own slug. With several apps, `dist` holds one subdirectory per slug.
 */
export function appDirResolver(manifest, distDir) {
  if (manifest.apps.length === 1) return () => distDir;
  return (slug) => join(distDir, slug);
}

/** Findings for every app in a manifest. */
export function checkApps(manifest, appDirFor) {
  return manifest.apps.flatMap((app) => checkApp(appDirFor(app.slug), app));
}

/**
 * Findings for a docs repo as it sits on disk: its manifest and its built output.
 *
 * What the CLI and the check-docs action run. A manifest that cannot be read or
 * fails the schema, and output that is missing, are findings too, rather than
 * a crash, so a caller always gets one list to report.
 *
 * @param {{manifest: string, dist: string}} paths - as the user gave them
 */
export function checkWorkspace({ manifest: manifestPath, dist }) {
  let manifest;
  try {
    manifest = readManifestFile(resolve(manifestPath));
  } catch (err) {
    if (!(err instanceof PublishError)) throw err;
    return [finding('KB-MAN-001', manifestPath, err.message.replace(/^KB-MAN-001 /, ''))];
  }
  const distDir = resolve(dist);
  if (!existsSync(distDir)) {
    return [finding('KB-ART-001', dist, 'the built output directory does not exist. Build the site first, or point "dist" at its output.')];
  }
  const appDirFor = appDirResolver(manifest, distDir);
  const missing = manifest.apps.filter((app) => !existsSync(appDirFor(app.slug)));
  if (missing.length > 0) {
    return missing.map((app) => finding('KB-ART-001', app.slug,
      `no built output at ${appDirFor(app.slug)} — with several apps, "dist" holds one subdirectory per slug.`));
  }
  return checkApps(manifest, appDirFor);
}

/**
 * Groups findings by rule: one entry per rule with its count and first example,
 * because a docs site repeats the same template on every page and forty
 * identical warnings bury the one that differs.
 */
export function summarise(findings) {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.id)) byRule.set(f.id, []);
    byRule.get(f.id).push(f);
  }
  return [...byRule.values()].map((group) => {
    const [first] = group;
    const count = group.length > 1 ? ` ×${group.length}, e.g.` : '';
    return {
      id: first.id,
      severity: first.severity,
      count: group.length,
      first,
      line: `${first.id}${count} ${first.where}: ${first.message}`,
    };
  });
}

/**
 * Checks every app in a manifest for the publish step: warnings are annotated,
 * and any error stops the publish with every error listed at once.
 *
 * @param {(slug: string) => string} appDirFor - resolves an app's built output
 */
export function verifyApps(manifest, appDirFor) {
  const findings = checkApps(manifest, appDirFor);
  const warnings = findings.filter((f) => f.severity === 'warning');
  const errors = findings.filter((f) => f.severity === 'error');

  for (const w of warnings) process.stdout.write(`::warning title=${w.id}::${formatFinding(w)}\n`);

  if (errors.length > 0) {
    throw new PublishError(
      `The built output does not satisfy the knowledge base contract (see ${RULES_DOC}):\n` +
      errors.map((e) => `  • ${formatFinding(e)}`).join('\n'),
    );
  }
  return { warnings };
}
