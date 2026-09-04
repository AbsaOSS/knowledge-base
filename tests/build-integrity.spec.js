/**
 * tests/build-integrity.spec.js
 *
 * Static checks on the built `dist/` output (no browser). Validates that the
 * build pipeline integrated both apps, enumerated every sub-app page, rewrote
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
import { isThemeBootstrap } from '../src/utils/transform.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const read = (rel) => readFileSync(join(DIST, rel), 'utf8');

/** Every .html file under dist/, recursively. */
function htmlFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/**
 * The knowledge base stylesheet a page loads. Astro injects this <link> from
 * Base.astro's CSS import, so the name is content-hashed and changes whenever
 * the stylesheet does — assert the shape, never a literal filename.
 */
function kbCssHref(html) {
  const href = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
    .map((tag) => tag[0].match(/\bhref="([^"]+)"/)?.[1])
    .find((h) => h?.startsWith('/knowledge-base/_astro/'));
  expect(href, 'page does not load the knowledge base stylesheet').toBeTruthy();
  return href;
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
    // Pages reference the content-hashed bundle; /knowledge-base/style.css stays
    // available as an alias of the same bytes for anything outside this
    // repository that still asks for it by that path.
    expect(existsSync(join(DIST, 'style.css')), 'dist/style.css alias missing').toBe(true);
    expect(read('style.css'), 'the alias is not a copy of the bundle the pages load')
      .toBe(read(kbCssHref(read('index.html')).slice('/knowledge-base/'.length)));
  });

  test('landing lists both app cards with absolute slug links', () => {
    const html = read('index.html');
    expect(html).toContain('User Guide');
    expect(html).toContain('Guide Mirror');
    expect(html).toContain('href="/knowledge-base/user-guide/"');
    expect(html).toContain('href="/knowledge-base/guide-mirror/"');
  });

  test('sub-app pages are marked headless and reference the knowledge base CSS', () => {
    const html = read('user-guide/index.html');
    expect(html).toContain('data-kb-headless="true"');
    expect(kbCssHref(html)).toMatch(/\.css$/);
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

// ── single-page onboarding (issue #35) ──────────────────────────────────────
//
// One registry entry (`type: "single-page"`, no per-doc metadata) points at a
// bundle holding two docs; the build must expand it into two independent apps.
test.describe('single-page onboarding', () => {
  test('one bundle entry expands into one app per doc', () => {
    for (const p of ['platform-overview/index.html', 'release-process/index.html']) {
      expect(existsSync(join(DIST, p)), `expected expanded single-page doc ${p}`).toBe(true);
    }
    // A single doc is one route — nothing is crawled underneath it.
    expect(existsSync(join(DIST, 'platform-overview/docs')), 'single-page app must emit exactly one route').toBe(false);
  });

  test('apps.json carries no per-doc metadata — the bundle manifest supplies it', () => {
    const registry = JSON.parse(readFileSync(join(ROOT, 'apps.json'), 'utf8'));
    const entry = registry.find((a) => a.type === 'single-page');
    expect(entry, 'no single-page entry in apps.json').toBeTruthy();
    expect(entry.slug, 'a single-page entry must not name a slug').toBeUndefined();
    expect(entry.name).toBeUndefined();

    // …yet the catalog knows both docs, which can only come from bundle.json.
    const html = read('index.html');
    expect(html).toContain('Platform Overview');
    expect(html).toContain('Release Process');
    expect(html).toContain('href="/knowledge-base/platform-overview/"');
    expect(html).toContain('href="/knowledge-base/release-process/"');
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
    expect(kbCssHref(html)).toMatch(/\.css$/);
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

  test('on the catalog, Library is the active crumb and no app crumb is shown', () => {
    const n = nav(read('index.html'));
    expect(n).toContain('aria-current="page"');
    expect(n).toContain('Library');
    // Library is inert here — no self-link back to the page you are on.
    expect(n).not.toMatch(/<a\b/);
  });

  test('inside an app, Library links to the catalog and the app is the active crumb', () => {
    const n = nav(read('user-guide/docs/index.html'));
    expect(n).toContain('href="/knowledge-base/"');
    expect(n).toContain('User Guide');
    // Deeper than the app index → the app crumb links back to the app root.
    expect(n).toContain('href="/knowledge-base/user-guide/"');
  });

  test('on an app index the app crumb is inert', () => {
    const n = nav(read('user-guide/index.html'));
    expect(n).toContain('href="/knowledge-base/"');       // Library still a link
    expect(n).not.toContain('href="/knowledge-base/user-guide/"');
    expect(n).toMatch(/aria-current="page"[\s\S]*User Guide/);
  });

  test('the crumb tracks the app being viewed', () => {
    expect(nav(read('guide-mirror/docs/index.html'))).toContain('Guide Mirror');
    expect(nav(read('external-docs/index.html'))).toContain('External Docs');
    // Expanded single-page docs are ordinary apps as far as the masthead cares.
    expect(nav(read('platform-overview/index.html'))).toContain('Platform Overview');
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
  test('the knowledge base stylesheet is content-hashed, not pinned to a constant name', () => {
    // Forcing "style.css" onto every CSS asset made Rollup disambiguate the
    // collisions as style.css / style2.css / …, which the build then had to
    // guess between — and it left the one stylesheet every page loads unable to
    // be cache-busted (#50). Every page's <link> is Astro-injected, so nothing
    // needed the constant name in the first place.
    expect(kbCssHref(read('index.html')))
      .toMatch(/^\/knowledge-base\/_astro\/[^/]+\.[A-Za-z0-9_-]{8,}\.css$/);
    expect(readdirSync(DIST).filter((f) => /^style\d+\.css$/.test(f)),
      'a style2.css means two bundles collided on one name again').toEqual([]);
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
});
