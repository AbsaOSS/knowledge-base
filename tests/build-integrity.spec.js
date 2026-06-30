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
    // Sub-app pages reference /__wf/knowledge-base/style.css → /knowledge-base/style.css
    // → dist/style.css. It must exist or every fragment page 404s its CSS.
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
    expect(html).toContain('/__wf/knowledge-base/style.css');
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
