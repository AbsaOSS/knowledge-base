/**
 * tests/build-integrity.spec.js
 *
 * Static checks on the built `dist/` output (no browser). Validates that the
 * build pipeline integrated every fixture app, enumerated every sub-app page, rewrote
 * URLs to absolute /{prefix}/{slug}/ paths, marked pages headless, and emitted
 * the knowledge base stylesheet at the stable name the sub-app pages reference.
 *
 * dist/ is produced by the Playwright webServer (setup-test-apps + build:headless)
 * before any test runs.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { parse } from 'parse5';
import { isThemeBootstrap } from '../src/utils/transform.js';
import { LAYER_ORDER, SUB_APP_LAYER } from '../src/utils/css-layers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const read = (rel) => readFileSync(join(DIST, rel), 'utf8');

/** Every file with the extension under dir, recursively. */
function filesWithExt(dir, ext, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) filesWithExt(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

/** Every .html file under dist/, recursively. */
const htmlFiles = (dir) => filesWithExt(dir, '.html');

/**
 * The knowledge base stylesheet a page carries. Base.astro inlines it into the
 * body of every page — inside a web fragment a head <link> is exactly the node
 * reframed may lose during a ClientRouter swap — so this is the block's text,
 * and there must be exactly one.
 */
function kbInlineStylesheet(html) {
  const blocks = [...html.matchAll(/<style\b[^>]*\bdata-kb-stylesheet\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  expect(blocks, 'page must carry exactly one inline knowledge base stylesheet').toHaveLength(1);
  return blocks[0];
}

test.describe('Build integrity', () => {
  test('produced dist/ with the landing page', () => {
    expect(existsSync(DIST), 'dist/ should exist after build').toBe(true);
    expect(existsSync(join(DIST, 'index.html')), 'landing index.html missing').toBe(true);
  });

  test('enumerated every sub-app page for both registered apps', () => {
    const pages = [
      'user-guide/index.html',
      'user-guide/docs/index.html',
      'user-guide/docs/customising/index.html',
      'user-guide/docs/adding-pages/index.html',
      'guide-mirror/index.html',
      'guide-mirror/docs/index.html',
      'guide-mirror/docs/customising/index.html',
    ];
    for (const p of pages) {
      expect(existsSync(join(DIST, p)), `expected built page ${p}`).toBe(true);
    }
  });

  test('the knowledge base stylesheet is published at the stable /style.css alias too', () => {
    // Pages carry the stylesheet inline; /knowledge-base/style.css stays
    // available as a file of the same bytes for anything outside this
    // repository that still asks for it by that path.
    expect(existsSync(join(DIST, 'style.css')), 'dist/style.css alias missing').toBe(true);
    expect(read('style.css'), 'the alias is not a copy of the stylesheet the pages carry')
      .toBe(kbInlineStylesheet(read('index.html')));
  });

  test('landing lists both app cards with absolute slug links', () => {
    const html = read('index.html');
    expect(html).toContain('User Guide');
    expect(html).toContain('Guide Mirror');
    expect(html).toContain('href="/knowledge-base/user-guide/"');
    expect(html).toContain('href="/knowledge-base/guide-mirror/"');
  });

  test('sub-app pages are marked headless and carry the knowledge base CSS', () => {
    const html = read('user-guide/index.html');
    expect(html).toContain('data-kb-headless="true"');
    expect(kbInlineStylesheet(html)).toBe(kbInlineStylesheet(read('index.html')));
  });

  test('sub-app pages are re-hosted by the layout, keeping their own head + body', () => {
    const html = read('user-guide/docs/index.html');
    // The sub-app's own stylesheet survives the split into the layout's head…
    expect(html).toContain('/knowledge-base/user-guide/docs/style.css');
    // …its body content is rendered inside the layout body…
    expect(html).toContain('id="docs-root"');
    // …and only one document shell exists (no nested <html>/<head>/<body>).
    expect(html.match(/<html\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<head\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<body\b/gi) ?? []).toHaveLength(1);
    // The layout owns <title>; the sub-app's is lifted into it, not duplicated.
    expect(html.match(/<title\b/gi) ?? []).toHaveLength(1);
  });

  test('sub-app URLs are rewritten to absolute paths (no relative/base leakage)', () => {
    const html = read('user-guide/docs/index.html');
    // Absolute rewrite present…
    expect(html).toMatch(/href="\/knowledge-base\/user-guide\/docs\/customising\/"/);
    // …and no leftover relative hrefs or <base> tag that would break in the shadow DOM.
    expect(html).not.toMatch(/href="(?!\/|https?:|mailto:|#|data:)[^"]/);
    expect(html).not.toMatch(/<base\b/i);
  });

  test('ClientRouter is injected into sub-app pages for SPA transitions', () => {
    const html = read('user-guide/docs/index.html');
    expect(html).toContain('astro-view-transitions-enabled');
  });
});

// ── iframe onboarding mode (issue #10) ──────────────────────────────────────
test.describe('iframe onboarding', () => {
  test('renders a single route with a full-viewport iframe to the external URL', () => {
    expect(existsSync(join(DIST, 'external-docs/index.html')), 'iframe app page missing').toBe(true);
    const html = read('external-docs/index.html');
    expect(html).toMatch(/<iframe[^>]*src="https:\/\/example\.com\/docs"/);
    // The iframe flex-fills whatever the masthead (and chrome, when standalone)
    // leaves of the viewport, rather than being hard-coded to 100vh.
    expect(html).toMatch(/<iframe[^>]*style="[^"]*flex:1 1 auto/);
    expect(html).toMatch(/<main style="[^"]*flex:1 1 auto/);
  });

  test('iframe entry does not produce packaged sub-app pages', () => {
    // No artifact was fetched/built — only the single index route exists.
    expect(existsSync(join(DIST, 'external-docs/docs')), 'unexpected packaged pages for iframe entry').toBe(false);
  });

  test('a per-app "headless": false wins over a headless build', () => {
    // The harness builds with --headless, and external-docs is pinned standalone
    // in apps.json. Base.astro used to OR the prop with the global flag, so the
    // override could only ever turn headless on (#52).
    expect(read('external-docs/index.html')).not.toContain('data-kb-headless');
    // …while its neighbours in the same build are still headless.
    expect(read('user-guide/index.html')).toContain('data-kb-headless="true"');
  });

  test('landing shows the iframe app card with an External badge', () => {
    const html = read('index.html');
    expect(html).toContain('External Docs');
    expect(html).toContain('kb-tag-external');
  });

  test('packaged apps are unaffected by the iframe entry', () => {
    expect(existsSync(join(DIST, 'user-guide/docs/index.html'))).toBe(true);
    expect(existsSync(join(DIST, 'guide-mirror/docs/index.html'))).toBe(true);
  });
});

// ── the pages navigation manifest ────────────────────────────────────────────
//
// Both apps come out of the same artifact and hold the same directory tree.
// `user-guide` declares no `pages`, so every HTML file becomes a route.
// `guide-mirror` declares four, deliberately omitting docs/some-new-page — which
// is present on disk. That asymmetry is the test: the manifest is authoritative
// when supplied, and the crawl is what happens only in its absence.
//
// This path had never run. fetch-apps.js merged the manifest over the registry
// entry, build-vite.js discarded the result for packaged apps, and Astro read
// apps.json alone — so `pages` never reached getAppPages and every app was
// crawled regardless of what its manifest said.
test.describe('pages navigation manifest', () => {
  test('an app with no pages manifest has every HTML file crawled into a route', () => {
    for (const p of [
      'user-guide/index.html',
      'user-guide/docs/index.html',
      'user-guide/docs/adding-pages/index.html',
      'user-guide/docs/customising/index.html',
      'user-guide/docs/some-new-page/index.html',
      'user-guide/admin/index.html',
    ]) {
      expect(existsSync(join(DIST, p)), `expected crawled page ${p}`).toBe(true);
    }
  });

  test('an app with a pages manifest gets exactly those routes and no others', () => {
    for (const p of [
      'guide-mirror/index.html',
      'guide-mirror/docs/index.html',
      'guide-mirror/docs/adding-pages/index.html',
      'guide-mirror/docs/customising/index.html',
    ]) {
      expect(existsSync(join(DIST, p)), `expected manifest page ${p}`).toBe(true);
    }

    // Present in the artifact, absent from the manifest, so not a route — while
    // the very same file is a route under the crawled app.
    expect(
      existsSync(join(DIST, 'guide-mirror/docs/some-new-page/index.html')),
      'a page the manifest omits must not be served',
    ).toBe(false);
    expect(existsSync(join(DIST, 'user-guide/docs/some-new-page/index.html'))).toBe(true);
  });

  test('titles come from the manifest, not from the document', () => {
    // "Adding Pages" is the manifest title for a page whose own <title> differs;
    // the masthead sub-nav is what surfaces it.
    const html = read('guide-mirror/docs/adding-pages/index.html');
    expect(html).toContain('Adding Pages');
  });
});

// ── single-page onboarding (issue #35) ──────────────────────────────────────
//
// One registry entry (a source and nothing else) points at a
// bundle holding two docs; the build must expand it into two independent apps.
test.describe('single-page onboarding', () => {
  test('one bundle entry expands into one app per doc', () => {
    for (const p of ['platform-overview/index.html', 'release-process/index.html']) {
      expect(existsSync(join(DIST, p)), `expected expanded single-page doc ${p}`).toBe(true);
    }
    // A single doc is one route — nothing is crawled underneath it.
    expect(existsSync(join(DIST, 'platform-overview/docs')), 'single-page app must emit exactly one route').toBe(false);
  });

  test('the registry carries no metadata at all — every manifest supplies its own', () => {
    const registry = JSON.parse(readFileSync(join(ROOT, 'apps.json'), 'utf8'));
    const artifactEntries = registry.filter((a) => a.type !== 'iframe');
    expect(artifactEntries.length, 'expected artifact entries in the registry').toBeGreaterThan(0);

    // The whole point of the source-only registry: an entry names a source and
    // nothing else, so onboarding a doc never edits this repository again.
    for (const entry of artifactEntries) {
      for (const field of ['slug', 'name', 'description', 'icon', 'tags', 'entryPoint', 'pages', 'type']) {
        expect(entry[field], `registry entry must not carry "${field}"`).toBeUndefined();
      }
      expect(
        Boolean(entry.repo) || Boolean(entry.prebuilt) || Boolean(entry.localPath),
        'every artifact entry names exactly one source',
      ).toBe(true);
    }

    // …yet the catalog knows every app, which can only come from the manifests.
    const html = read('index.html');
    for (const [name, slug] of [
      ['Platform Overview', 'platform-overview'],
      ['Release Process',   'release-process'],
      ['User Guide',        'user-guide'],
      ['Guide Mirror',      'guide-mirror'],
    ]) {
      expect(html).toContain(name);
      expect(html).toContain(`href="/knowledge-base/${slug}/"`);
    }
  });

  test('renders in the centred reading column, with no sidebar', () => {
    const html = read('platform-overview/index.html');
    expect(html).toMatch(/<main id="content" class="kb-single-page"/);
    expect(html).toContain('class="kb-doc"');
    // Single-page docs have no navigation of their own — the masthead is it.
    expect(html).not.toContain('id="sidebar"');
    expect(html).not.toMatch(/<nav[^>]*aria-label="Documentation"/);
    expect(html).toContain('id="kb-masthead"');
  });

  test('is re-hosted by the layout like any packaged page', () => {
    const html = read('platform-overview/index.html');
    expect(html).toContain('data-kb-headless="true"');
    expect(kbInlineStylesheet(html)).toContain('.kb-single-page');
    expect(html.match(/<html\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<head\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<body\b/gi) ?? []).toHaveLength(1);
    expect(html.match(/<title\b/gi) ?? []).toHaveLength(1);
  });

  test('bundle asset URLs are rewritten to absolute /{prefix}/{slug}/ paths', () => {
    const html = read('platform-overview/index.html');
    expect(html).toContain('href="/knowledge-base/platform-overview/assets/doc.css"');
    expect(html).not.toMatch(/href="(?!\/|https?:|mailto:|#|data:)[^"]/);
    expect(html).not.toMatch(/<base\b/i);

    // …and the assets themselves shipped alongside the page.
    expect(existsSync(join(DIST, 'platform-overview/assets/doc.css'))).toBe(true);
    expect(existsSync(join(DIST, 'release-process/assets/doc.css'))).toBe(true);
  });

  test('renders the markdown features the contract promises', () => {
    const html = read('platform-overview/index.html');
    expect(html).toContain('<table>');                        // GFM tables
    expect(html).toContain('task-list-item');                 // GFM task lists
    expect(html).toContain('<pre class="kb-code">');          // fenced code
    expect(html).toContain('hljs-keyword');                   // syntax highlighting
    expect(html).toMatch(/<pre class="mermaid">flowchart LR/); // mermaid source survives
  });

  test('mermaid is vendored into the artifact, never fetched from a CDN', () => {
    const html = read('platform-overview/index.html');
    expect(html).toContain('src="/knowledge-base/platform-overview/assets/mermaid.min.js"');
    expect(html).not.toMatch(/src="https?:\/\/[^"]*mermaid/);
    expect(existsSync(join(DIST, 'platform-overview/assets/mermaid.min.js')), 'vendored mermaid missing').toBe(true);
  });

  test('the other onboarding types are unaffected', () => {
    expect(existsSync(join(DIST, 'user-guide/docs/index.html'))).toBe(true);
    expect(existsSync(join(DIST, 'guide-mirror/docs/index.html'))).toBe(true);
    expect(existsSync(join(DIST, 'external-docs/index.html'))).toBe(true);
  });
});

// ── Persistent masthead (issue #24) ─────────────────────────────────────────
test.describe('Masthead', () => {
  const STRAPLINE = 'Browse and access all documentation sites';

  const nav = (html) => html.match(/<nav class="kb-masthead-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';

  test('renders on the landing page, packaged pages and iframe pages', () => {
    for (const p of ['index.html', 'user-guide/index.html', 'user-guide/docs/index.html', 'external-docs/index.html']) {
      const html = read(p);
      expect(html, `masthead missing on ${p}`).toContain('id="kb-masthead"');
      expect(html, `strapline missing on ${p}`).toContain(STRAPLINE);
    }
  });

  /** The wide bar: Library, the current app and its entries. */
  const bar = (html) => html.match(/<ul class="kb-nav-bar"[\s\S]*?<\/ul><div class="kb-nav-compact"/)?.[0] ?? '';
  /** The compact menu sheet, empty when the page has none. */
  const sheet = (html) => html.match(/<div id="kb-nav-menu"[\s\S]*?<\/nav>/)?.[0] ?? '';
  /** Every element carrying aria-current, as `value → text`. */
  const current = (html) => [...html.matchAll(/<(a|summary)\b[^>]*aria-current="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)]
    .map(([, , value, text]) => `${value} → ${text.replace(/<svg[\s\S]*?<\/svg>|<[^>]+>/g, '').trim()}`);
  /** Positions of `>name<` in html, -1 for a missing name. */
  const positions = (html, names) => names.map((name) => html.indexOf(`>${name}<`));
  const APPS = ['User Guide', 'Guide Mirror', 'Handbook', 'External Docs', 'Platform Overview', 'Release Process'];
  const PAGES = [
    'index.html', 'user-guide/index.html', 'user-guide/docs/index.html', 'guide-mirror/index.html',
    'guide-mirror/docs/index.html', 'guide-mirror/docs/adding-pages/index.html', 'external-docs/index.html',
    'platform-overview/index.html',
  ];

  test('on the catalog the bar holds the Library alone: the catalog is the way to an app', () => {
    const html = read('index.html');
    expect(positions(bar(html), APPS).every((i) => i < 0), 'an app is listed on the catalog').toBe(true);
    expect(bar(html)).toContain('>Library<');
    expect(html).not.toContain('class="kb-nav-toggle"');
    expect(sheet(html)).toBe('');
  });

  test('an app page shows Library, the app, then only that app\'s entries, in manifest order', () => {
    for (const p of ['guide-mirror/index.html', 'guide-mirror/docs/index.html', 'guide-mirror/docs/adding-pages/index.html']) {
      const html = bar(read(p));
      const at = positions(html, ['Library', 'Guide Mirror', 'Showcase', 'Overview', 'Guide']);
      expect(at.every((i) => i >= 0), `an entry is missing on ${p}: ${at}`).toBe(true);
      expect([...at].sort((a, b) => a - b), `entries out of order on ${p}`).toEqual(at);
      const others = positions(html, APPS.filter((name) => name !== 'Guide Mirror'));
      expect(others.every((i) => i < 0), `another app is listed on ${p}`).toBe(true);
    }
  });

  test('a section is a dropdown of its pages; a page without one is a plain link', () => {
    const html = bar(read('guide-mirror/index.html'));
    const dropdowns = html.match(/<details class="kb-nav-dropdown"[\s\S]*?<\/details>/g) ?? [];
    expect(dropdowns).toHaveLength(1);
    expect(dropdowns[0]).toMatch(/<summary[^>]*>\s*<span>Guide<\/span>/);
    const pages = [...dropdowns[0].matchAll(/<a class="kb-nav-page[^"]*" href="([^"]+)"[^>]*>([^<]+)</g)].map(([, h, t]) => `${t} ${h}`);
    expect(pages).toEqual([
      'Adding Pages /knowledge-base/guide-mirror/docs/adding-pages/',
      'Customising /knowledge-base/guide-mirror/docs/customising/',
    ]);
    const links = [...html.matchAll(/<li class="kb-nav-item"><a class="kb-masthead-link[^"]*" href="([^"]+)"[^>]*>([^<]+)</g)].map(([, h, t]) => `${t} ${h}`);
    expect(links).toEqual(['Showcase /knowledge-base/guide-mirror/', 'Overview /knowledge-base/guide-mirror/docs/']);
  });

  test('each section of a manifest is its own dropdown, and the entries are the app\'s own', () => {
    const html = bar(read('handbook/docs/adding-pages/index.html'));
    const at = positions(html, ['Library', 'Handbook', 'Showcase', 'Getting started', 'Authoring']);
    expect(at.every((i) => i >= 0), `an entry is missing: ${at}`).toBe(true);
    expect([...at].sort((a, b) => a - b), 'entries out of order').toEqual(at);
    expect(positions(html, ['Guide Mirror', 'Guide']).every((i) => i < 0), 'another app\'s entries leaked in').toBe(true);

    const dropdowns = html.match(/<details class="kb-nav-dropdown"[\s\S]*?<\/details>/g) ?? [];
    const pages = dropdowns.map((d) => [...d.matchAll(/<a class="kb-nav-page[^"]*" href="([^"]+)"[^>]*>([^<]+)</g)].map(([, h, t]) => `${t} ${h}`));
    expect(pages).toEqual([
      ['Overview /knowledge-base/handbook/docs/', 'Customising /knowledge-base/handbook/docs/customising/'],
      ['Adding Pages /knowledge-base/handbook/docs/adding-pages/', 'New Page /knowledge-base/handbook/docs/some-new-page/'],
    ]);
    expect(current(html)).toEqual(['true → Handbook', 'true → Authoring', 'page → Adding Pages']);
  });

  test('an app without a manifest shows its name and nothing after it', () => {
    for (const p of ['user-guide/docs/index.html', 'external-docs/index.html', 'platform-overview/index.html']) {
      const html = read(p);
      expect(bar(html), p).not.toContain('kb-nav-item');
      expect(bar(html), p).not.toContain('kb-nav-scope-mark');
      expect(html, p).not.toContain('class="kb-nav-toggle"');
      expect(sheet(html), p).toBe('');
    }
  });

  test('every menu link resolves to a built page', () => {
    const hrefs = new Set(PAGES.flatMap((p) => [...read(p).matchAll(/<a class="kb-(?:masthead-link|nav-page)[^"]*" href="([^"]+)"/g)].map((m) => m[1])));
    expect(hrefs.size).toBeGreaterThan(APPS.length);
    for (const h of hrefs) {
      const rel = h.replace(/^\/knowledge-base\//, '');
      expect(existsSync(join(DIST, rel, 'index.html')), `${h} has no page`).toBe(true);
    }
  });

  test('on the catalog, Library is the current page', () => {
    expect(current(bar(read('index.html')))).toEqual(['page → Library']);
  });

  test('on a manifest page, the page is current and the app and section holding it are marked', () => {
    const html = read('guide-mirror/docs/adding-pages/index.html');
    expect(current(bar(html))).toEqual(['true → Guide Mirror', 'true → Guide', 'page → Adding Pages']);
    expect(current(sheet(html))).toEqual(['page → Adding Pages']);
    expect(bar(html)).not.toMatch(/<details[^>]*\bopen\b/);
    // The app root is a manifest page here, so that entry is the current one, not the app.
    expect(current(bar(read('guide-mirror/index.html')))).toEqual(['true → Guide Mirror', 'page → Showcase']);
  });

  test('without a manifest, the app is the current page at its root and holds it deeper in', () => {
    expect(current(bar(read('user-guide/index.html')))).toEqual(['page → User Guide']);
    expect(current(bar(read('user-guide/docs/index.html')))).toEqual(['true → User Guide']);
    expect(current(bar(read('external-docs/index.html')))).toEqual(['page → External Docs']);
    // Expanded single-page docs are ordinary apps as far as the masthead cares.
    expect(current(bar(read('platform-overview/index.html')))).toEqual(['page → Platform Overview']);
  });

  test('the compact bar names the current app and opens a menu of its pages', () => {
    const html = read('guide-mirror/docs/index.html');
    const compact = html.match(/<div class="kb-nav-compact"[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(compact).toContain('Guide Mirror');
    expect(compact).toMatch(/<button type="button" class="kb-nav-toggle" popovertarget="kb-nav-menu" aria-label="Guide Mirror pages"/);
    expect(html).toMatch(/<div id="kb-nav-menu" class="kb-nav-sheet" popover>/);
    const menu = sheet(html);
    expect(positions(menu, ['Showcase', 'Overview', 'Guide', 'Adding Pages', 'Customising']).every((i) => i >= 0)).toBe(true);
    expect(positions(menu, APPS.filter((name) => name !== 'Guide Mirror')).every((i) => i < 0)).toBe(true);
  });

  test('all masthead links are absolute /knowledge-base/ paths', () => {
    for (const p of ['user-guide/docs/customising/index.html', 'external-docs/index.html']) {
      const hrefs = [...nav(read(p)).matchAll(/href="([^"]*)"/g)].map(m => m[1]);
      expect(hrefs.length, `no masthead links on ${p}`).toBeGreaterThan(0);
      for (const h of hrefs) expect(h, `${h} on ${p} is not an absolute prefixed path`).toMatch(/^\/knowledge-base\//);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSP preconditions
//
// The knowledge base serves script-src 'self' with no 'unsafe-inline'. That only
// holds while nothing inline survives the build — so the build output is the
// thing asserted, not the intent. If this fails, the CSP is about to start
// breaking pages silently.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('no inline scripts in the build output', () => {
  test('every <script> in dist/ has a src', () => {
    const offenders = [];
    for (const file of htmlFiles(DIST)) {
      const html = readFileSync(file, 'utf8');
      for (const [tag, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/i.test(attrs)) continue;
        if (body.trim() === '') continue;
        // Data blocks are not executable and CSP does not apply to them.
        const type = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase() ?? '';
        if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
        offenders.push(`${relative(DIST, file)}: ${tag.slice(0, 80)}`);
      }
    }
    expect(
      offenders,
      "inline <script> in the output — script-src 'self' would block it. " +
      'scripts/hoist-inline-scripts.js should have moved it to a file.',
    ).toEqual([]);
  });

  test('inline scripts from sub-app artifacts were hoisted to files', () => {
    // The vendored docs-example fixture ships inline scripts, so this asserts
    // the hoist actually ran rather than that there was nothing to do.
    const hoistDirs = htmlFiles(DIST)
      .map((f) => dirname(f))
      .filter((d) => existsSync(join(d, '_kb-inline')));
    expect(hoistDirs.length, 'no _kb-inline/ directory anywhere — did the hoist step run?')
      .toBeGreaterThan(0);
  });

  test('hoisted scripts are referenced by absolute prefixed paths', () => {
    // A nested page: the fixture's inline script lives on an inner page, so this
    // also covers the ../ depth computation — a hoisted script referenced from
    // user-guide/admin/ must still resolve to the app root, not one level up.
    const html = read('user-guide/admin/index.html');
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    const hoisted = srcs.filter((s) => s.includes('_kb-inline'));
    expect(hoisted.length, 'user-guide/admin should reference hoisted scripts').toBeGreaterThan(0);
    for (const src of hoisted) {
      expect(src, 'hoisted script must be rewritten like every other URL').toMatch(/^\/knowledge-base\/user-guide\/_kb-inline\//);
      expect(existsSync(join(DIST, src.replace(/^\/knowledge-base\//, ''))), `${src} is not in dist/`).toBe(true);
    }
  });

  test('no element in dist/ carries an inline event handler', () => {
    // script-src 'self' blocks onclick="…" exactly like an inline <script>, so
    // one that survives is dead in production and live under astro dev. Walked
    // as a parsed tree: `onclick="…"` quoted in a code sample is prose, not an
    // attribute.
    const offenders = [];
    const walk = (node, file) => {
      for (const child of node.childNodes ?? []) {
        for (const attr of child.attrs ?? []) {
          if (/^on./i.test(attr.name)) offenders.push(`${relative(DIST, file)}: <${child.tagName} ${attr.name}>`);
        }
        if (child.content) walk(child.content, file);
        walk(child, file);
      }
    };
    for (const file of htmlFiles(DIST)) walk(parse(readFileSync(file, 'utf8')), file);
    expect(offenders, "inline on* handler in the output — script-src 'self' blocks it; transform.js should strip it").toEqual([]);
  });

  test('the fixture theme toggle survives without its handler', () => {
    // The docs-example fixture ships `<button id="theme-toggle" onclick="…">`,
    // so this asserts the strip ran on a real handler rather than that there
    // was nothing to strip.
    const html = read('user-guide/docs/index.html');
    const button = html.match(/<button\b[^>]*\bid="theme-toggle"[^>]*>/)?.[0];
    expect(button, 'fixture no longer ships the theme toggle — pick another handler-bearing element').toBeTruthy();
    expect(button).not.toMatch(/\bon[a-z]+=/i);
  });

  test('the sub-app theme bootstrap is deleted, not hoisted into a file', () => {
    // The docs-example fixture ships a `localStorage`-driven dark-mode bootstrap.
    // Hoisting it would turn it into an external script the light-only strip can
    // no longer see, and it would then re-add `dark` in the browser (#48).
    const offenders = htmlFiles(DIST)
      .flatMap((file) => {
        const html = readFileSync(file, 'utf8');
        const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
        return srcs
          .filter((s) => s.includes('_kb-inline'))
          .map((s) => join(DIST, s.replace(/^\/knowledge-base\//, '')))
          .filter((p) => existsSync(p) && isThemeBootstrap(readFileSync(p, 'utf8')))
          .map((p) => `${relative(DIST, file)} → ${relative(DIST, p)}`);
      });
    expect(offenders, 'a theme bootstrap survived as a hoisted file — the page can still go dark').toEqual([]);
  });
});

// ── CSS asset handling (#49, #50) ───────────────────────────────────────────
test.describe('stylesheet emission', () => {
  test('no page links a stylesheet of its own from its head — every page inlines the knowledge base CSS', () => {
    // Inside a web fragment the head is reframed's, and a <link> there is the
    // node it may lose during a ClientRouter swap; the catalog and masthead
    // would then render unstyled. The stylesheet travels in the body instead,
    // where it is replaced together with the page it styles. The only <link
    // rel="stylesheet"> left are the sub-apps' own, which are layered instead.
    for (const file of htmlFiles(DIST)) {
      const html = readFileSync(file, 'utf8');
      const rel = relative(DIST, file);
      const kbLinks = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
        .map((tag) => tag[0].match(/\bhref="([^"]+)"/)?.[1])
        .filter((h) => h?.startsWith('/knowledge-base/_astro/'));
      expect(kbLinks, `${rel} links an Astro-emitted stylesheet from its head`).toEqual([]);
      const css = kbInlineStylesheet(html);
      expect(css, `${rel}: the inline stylesheet is not the compiled knowledge base CSS`).toContain('.kb-masthead');
      expect(css, `${rel}: the inline stylesheet must carry the fence layer`).toContain('@layer kb-reset');
      // Tailwind drops a bare `@layer a, b;` from its output, so the order has
      // to be prepended by the layout — and it has to be there, or a runtime
      // that parses this block before the head orders `kb-app` above the fence.
      expect(css.startsWith(LAYER_ORDER), `${rel}: the inline stylesheet must open with the layer order`).toBe(true);
      // Body-first: parsed before any content it styles.
      expect(html.indexOf('data-kb-stylesheet'), `${rel}: the stylesheet must open the body`)
        .toBeLessThan(html.indexOf('id="kb-masthead"'));
    }
    expect(readdirSync(DIST).filter((f) => /^style\d+\.css$/.test(f)),
      'a style2.css means two bundles collided on one name again').toEqual([]);
  });

  test('the layout declares the cascade layer order before anything else in the head', () => {
    // Layer priority is fixed by the first statement naming the layers, so
    // this must precede every sub-app <link>/<style> the head slot brings in.
    for (const file of htmlFiles(DIST)) {
      const html = readFileSync(file, 'utf8');
      const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
      const first = head.search(/<(style|link)\b/i);
      expect(head.slice(first), `${relative(DIST, file)}: first style node in head is not the layer order`)
        .toMatch(new RegExp(`^<style>${LAYER_ORDER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</style>`));
    }
  });

  test('every sub-app stylesheet is served wrapped in the sub-app cascade layer', () => {
    // Below the knowledge base's own rules, so a sheet that outlives its page
    // inside a web fragment cannot restyle the masthead or the catalog.
    const appCss = ['user-guide', 'guide-mirror', 'platform-overview', 'release-process']
      .flatMap((slug) => filesWithExt(join(DIST, slug), '.css'));
    expect(appCss.length, 'no sub-app CSS in dist/').toBeGreaterThan(0);
    for (const file of appCss) {
      const css = readFileSync(file, 'utf8');
      const rel = relative(DIST, file);
      expect(css.startsWith(LAYER_ORDER), `${rel} does not open with the layer order`).toBe(true);
      expect(css, `${rel} is not wrapped in the sub-app layer`).toContain(`@layer ${SUB_APP_LAYER}{`);
    }
    // The fixture docs theme is itself Tailwind output declaring theme/base/
    // components/utilities — nested inside kb-app they stay the app's own.
    const docs = read('user-guide/docs/style.css');
    const block = docs.indexOf(`@layer ${SUB_APP_LAYER}{`);
    expect(docs.indexOf('@layer theme', block + 1), "the app's own layers must sit inside the block").toBeGreaterThan(block);
  });

  test('every CSS asset carries a content hash', () => {
    const astroDir = join(DIST, '_astro');
    const unhashed = (existsSync(astroDir) ? readdirSync(astroDir) : [])
      .filter((f) => f.endsWith('.css') && !/[.-][A-Za-z0-9_-]{8,}\.css$/.test(f));
    expect(unhashed, 'an unhashed CSS asset cannot be cached immutably').toEqual([]);
  });

  test('the typeface is self-hosted, with no third-party font origin anywhere', () => {
    // Inter used to come from fonts.googleapis.com on every page view (#54).
    const offenders = [...htmlFiles(DIST), join(DIST, 'style.css')]
      .filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(DIST, f));
    expect(offenders, 'a Google Fonts origin survived into the build').toEqual([]);

    // …and the faces it does load are same-origin, hashed and present.
    const fonts = [...read('style.css').matchAll(/url\((\/knowledge-base\/[^)]+\.woff2)\)/g)].map((m) => m[1]);
    expect(fonts.length, 'no self-hosted font in the knowledge base stylesheet').toBeGreaterThan(0);
    for (const font of fonts) {
      expect(existsSync(join(DIST, font.replace('/knowledge-base/', ''))), `${font} is not in dist/`).toBe(true);
    }
  });

  test('the CSS url() rewrite does not write back into the artifact', () => {
    // Assets are hardlinked from apps/ into public/ rather than copied (#51), so
    // a stylesheet edited in place would corrupt the extracted artifact itself.
    // CSS is deliberately the one kind copied for real.
    const source = readFileSync(join(ROOT, 'apps/platform-overview/assets/depth-check.css'), 'utf8');
    expect(source, 'the rewrite reached back into apps/ — CSS must not be hardlinked')
      .toContain('url(/fonts/demo.woff2)');
    expect(read('platform-overview/assets/depth-check.css')).toContain('url(/knowledge-base/platform-overview/');
  });

  test('root-relative url() in sub-app CSS is rebased onto the app, at any depth', () => {
    // The rewrite used to hardcode `../`, which is only correct for a stylesheet
    // exactly one directory deep; from {slug}/assets/ it pointed outside the app
    // and from {slug}/ it escaped the app entirely (#49).
    const css = read('platform-overview/assets/depth-check.css');
    expect(css).toContain('url(/knowledge-base/platform-overview/fonts/demo.woff2)');
    expect(css, 'a relative hop from assets/ resolves outside the app').not.toContain('url(../');
    // Untouched forms stay untouched.
    expect(css).toContain('url(data:image/gif;base64,R0lGOD)');
    expect(css).toContain('url(#clip)');
    expect(css).toContain('url(//cdn.example.com/x.png)');
  });

  test('relative url() in sub-app CSS is resolved against the stylesheet, not left relative', () => {
    // Embedded with piercing, reframed copies a linked sheet's rules into a
    // constructed stylesheet, which resolves URLs against the HOST document —
    // so a relative url() fetched /knowledge-base/docs/… instead of
    // /knowledge-base/user-guide/docs/…. Only an absolute URL survives that.
    expect(read('user-guide/showcase.css'))
      .toContain("url('/knowledge-base/user-guide/docs/assets/images/hero.png')");

    const subAppCss = filesWithExt(DIST, '.css')
      .map((f) => relative(DIST, f).split('\\').join('/'))
      .filter((f) => f.includes('/') && !f.startsWith('_astro/'));
    expect(subAppCss.length, 'no sub-app stylesheet found in dist/').toBeGreaterThan(0);
    for (const file of subAppCss) {
      const css = read(file);
      const urls = [...css.matchAll(/url\(\s*['"]?([^'")]*)/gi), ...css.matchAll(/@import\s+['"]([^'"]*)/gi)]
        .map((m) => m[1].trim())
        .filter((u) => u && !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u));
      for (const u of urls) {
        expect(u, `${file}: relative URL left in a sub-app stylesheet`).toMatch(/^\/knowledge-base\//);
      }
    }
  });
});
