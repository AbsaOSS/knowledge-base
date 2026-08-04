/**
 * tests/build-integrity.spec.js
 *
 * Static checks on the built `dist/` output (no browser). Validates that the
 * build pipeline integrated both apps, enumerated every sub-app page, rewrote
 * URLs to absolute /{prefix}/{slug}/ paths, marked pages headless, and emitted
 * the marketplace stylesheet at the stable name the sub-app pages reference.
 *
 * dist/ is produced by the Playwright webServer (setup-test-apps + build:headless)
 * before any test runs.
 */

import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const read = (rel) => readFileSync(join(DIST, rel), 'utf8');

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

  test('marketplace stylesheet is emitted at the stable /style.css name', () => {
    // Every page references /knowledge-base/style.css → dist/style.css (the gateway
    // also reaches it via /__wf/knowledge-base/style.css). It must exist or every
    // fragment page 404s its CSS.
    expect(existsSync(join(DIST, 'style.css')), 'dist/style.css missing — sub-app CSS would 404').toBe(true);
  });

  test('landing lists both app cards with absolute slug links', () => {
    const html = read('index.html');
    expect(html).toContain('User Guide');
    expect(html).toContain('Guide Mirror');
    expect(html).toContain('href="/knowledge-base/user-guide/"');
    expect(html).toContain('href="/knowledge-base/guide-mirror/"');
  });

  test('sub-app pages are marked headless and reference the marketplace CSS', () => {
    const html = read('user-guide/index.html');
    expect(html).toContain('data-mp-headless="true"');
    expect(html).toContain('/knowledge-base/style.css');
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

  test('landing shows the iframe app card with an External badge', () => {
    const html = read('index.html');
    expect(html).toContain('External Docs');
    expect(html).toContain('mp-tag-external');
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
    expect(html).toMatch(/<main id="content" class="mp-single-page"/);
    expect(html).toContain('class="mp-doc"');
    // Single-page docs have no navigation of their own — the masthead is it.
    expect(html).not.toContain('id="sidebar"');
    expect(html).not.toMatch(/<nav[^>]*aria-label="Documentation"/);
    expect(html).toContain('id="mp-masthead"');
  });

  test('is re-hosted by the layout like any packaged page', () => {
    const html = read('platform-overview/index.html');
    expect(html).toContain('data-mp-headless="true"');
    expect(html).toContain('/knowledge-base/style.css');
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
    expect(html).toContain('<pre class="mp-code">');          // fenced code
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

  const nav = (html) => html.match(/<nav class="mp-masthead-nav"[\s\S]*?<\/nav>/)?.[0] ?? '';

  test('renders on the landing page, packaged pages and iframe pages', () => {
    for (const p of ['index.html', 'user-guide/index.html', 'user-guide/docs/index.html', 'external-docs/index.html']) {
      const html = read(p);
      expect(html, `masthead missing on ${p}`).toContain('id="mp-masthead"');
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
