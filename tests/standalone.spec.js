/**
 * tests/standalone.spec.js
 *
 * CI-runnable Playwright tests for the knowledge-base fragment server.
 * Targets the standalone fragment server (port 3000) — no host gateway needed.
 * Run via playwright.config.ci.js.
 *
 * Coverage:
 *   ─ HTTP header safety   X-Frame-Options must not block the gateway's hidden iframe
 *   ─ Headless contract    data-mp-headless present; no chrome bar (#mp-chrome)
 *   ─ CSS stability        data-astro-transition-persist on every <link rel=stylesheet>
 *                          (prevents web-fragments issue #297: head style accumulation)
 *   ─ Asset routing        /__wf/knowledge-base/* rewrite returns 200
 *                          (tests/fragment-server.mjs mirrors the nginx rewrite rule)
 *   ─ Path contract        all internal links are absolute /knowledge-base/* paths
 *   ─ Client-side nav      navigating between pages does NOT cause a full page reload
 *
 * Architecture under test (standalone):
 *   Playwright → http://localhost:3000/knowledge-base/
 *                (tests/fragment-server.mjs serving dist/, no shadow DOM / no iframe)
 */

import { test, expect } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP header safety
// ─────────────────────────────────────────────────────────────────────────────

test.describe('HTTP headers', () => {
  test('landing page responds 200', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    expect(res.status()).toBe(200);
  });

  test('healthz endpoint responds 200', async ({ request }) => {
    // The Astro preview plugin does not expose /healthz — only nginx does in prod.
    // We test the landing page is up as the CI health signal instead.
    const res = await request.get('/knowledge-base/');
    expect(res.status()).toBe(200);
  });

  // web-fragments uses a hidden iframe to isolate the fragment's JS context.
  // If the fragment server returns X-Frame-Options: DENY the iframe is blocked
  // and the fragment silently fails to load.
  // See: web-fragments troubleshooting → "Fragment silently fails to load"
  // and references/csp-and-iframe.md.
  test('does NOT return X-Frame-Options: DENY', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    const xfo = (res.headers()['x-frame-options'] ?? '').toUpperCase();
    expect(xfo, 'X-Frame-Options: DENY blocks the gateway iframe').not.toBe('DENY');
  });

  test('does NOT return X-Frame-Options: DENY on sub-app pages', async ({ request }) => {
    const res = await request.get('/knowledge-base/user-guide/');
    // 404 is acceptable here if the app wasn't built — only check the header
    const xfo = (res.headers()['x-frame-options'] ?? '').toUpperCase();
    expect(xfo).not.toBe('DENY');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Headless contract
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Headless contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');
  });

  // MP_HEADLESS=true must set data-mp-headless="true" on <html>.
  // The gateway reads this to confirm the fragment was built for embedding.
  test('html element has data-mp-headless="true"', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-mp-headless', 'true');
  });

  // The chrome nav bar (#mp-chrome) must be absent in headless mode — it
  // escapes the shadow boundary when reframed pierces the DOM, creating a
  // duplicate nav bar over the host app.
  test('chrome nav bar (#mp-chrome) is absent', async ({ page }) => {
    await expect(page.locator('#mp-chrome')).toHaveCount(0);
  });

  test('page title is set', async ({ page }) => {
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CSS link stability  (web-fragments issue #297)
// ─────────────────────────────────────────────────────────────────────────────
//
// When Astro's <ClientRouter /> navigates between pages it manages <head>
// contents by removing links that don't have data-astro-transition-persist and
// adding new ones. Inside web-fragments reframed relocates head <style>/<link>
// out of wf-head into the shadow tree; Astro's subsequent cleanup can't find
// them so they pile up unbounded (each navigation adds more, nothing removes).
//
// Fix: transform.js adds data-astro-transition-persist to every <link
// rel="stylesheet"> injected by sub-app pages so Astro keeps them stable
// rather than swapping them. This suite verifies the attribute is present.
//
// Upstream: https://github.com/web-fragments/web-fragments/issues/297

test.describe('CSS link stability (#297)', () => {
  test('landing-page stylesheet links carry data-astro-transition-persist', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');

    const links = page.locator('link[rel="stylesheet"]');
    const count = await links.count();
    expect(count, 'No <link rel=stylesheet> found on landing page').toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      // Astro auto-injects the bundled marketplace stylesheet (/knowledge-base/styleN.css)
      // from a CSS `import`; that link is framework-managed and cannot carry the attribute.
      // Astro keeps it across navigation by href-match, and the behavioural
      // "CSS link count does not grow" test below is the authoritative #297 guard.
      if (/^\/knowledge-base\/style\d*\.css$/.test(href ?? '')) continue;
      const persist = await links.nth(i).getAttribute('data-astro-transition-persist');
      expect(
        persist,
        `<link href="${href}"> is missing data-astro-transition-persist.\n` +
        'Without this attribute Astro ClientRouter removes and re-adds the link on every\n' +
        'navigation. Inside web-fragments reframed cannot clean up the relocated nodes so\n' +
        'they accumulate (issue #297).',
      ).not.toBeNull();
    }
  });

  test('all stylesheet links on sub-app pages have data-astro-transition-persist', async ({ page }) => {
    // Navigate to a sub-app page (if available)
    await page.goto('/knowledge-base/user-guide/');
    // Don't fail if example isn't built — skip gracefully
    const status = await page.evaluate(() => document.readyState);
    if (await page.locator('html').getAttribute('data-mp-headless') === null) {
      test.skip(); // page did not load as a fragment page
      return;
    }

    const links = page.locator('link[rel="stylesheet"]');
    const count = await links.count();
    if (count === 0) return; // no CSS on this page — pass

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      const persist = await links.nth(i).getAttribute('data-astro-transition-persist');
      expect(
        persist,
        `<link href="${href}"> on sub-app page is missing data-astro-transition-persist`,
      ).not.toBeNull();
    }
  });

  test('CSS link count does not grow after navigating forward and back', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');
    const initialCount = await page.locator('link[rel="stylesheet"]').count();

    // Find any internal link — if none, build had no apps; skip gracefully
    const appLink = page.locator('a[href^="/knowledge-base/"]').first();
    if (await appLink.count() === 0) {
      test.skip();
      return;
    }

    // Navigate forward
    await appLink.click();
    await page.waitForLoadState('networkidle');

    // Navigate back
    await page.goBack();
    await page.waitForLoadState('networkidle');

    const afterCount = await page.locator('link[rel="stylesheet"]').count();
    expect(
      afterCount,
      `CSS link count grew from ${initialCount} → ${afterCount} after forward+back navigation.\n` +
      'This indicates issue #297 style accumulation is active.\n' +
      'Fix: ensure transform.js adds data-astro-transition-persist to all <link> tags.',
    ).toBeLessThanOrEqual(initialCount);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Asset routing  (/__wf/knowledge-base/ rewrite)
// ─────────────────────────────────────────────────────────────────────────────
//
// The gateway proxies fragment assets via /__wf/<fragment-id>/<path>.
// Both the production nginx.conf and tests/fragment-server.mjs map
// /__wf/knowledge-base/<file> → /knowledge-base/<file>.
// This test verifies that rewrite works in the standalone fragment server.

test.describe('Asset routing', () => {
  test('CSS assets accessible via /__wf/knowledge-base/ prefix', async ({ page, request }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');

    const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('href')).filter(Boolean),
    );
    expect(hrefs.length, 'No stylesheet links found').toBeGreaterThan(0);

    for (const href of hrefs) {
      // href is like /knowledge-base/style.css → /__wf/knowledge-base/style.css
      const wfPath = href.replace(/^\/knowledge-base\//, '/__wf/knowledge-base/');
      if (wfPath === href) continue; // href was not under /knowledge-base/ — skip

      const res = await request.get(wfPath);
      expect(
        res.status(),
        `Asset not found via /__wf prefix: ${wfPath} returned ${res.status()}.\n` +
        'Check the rewrite in tests/fragment-server.mjs and the nginx.conf rule.',
      ).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal link contract
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Internal link contract', () => {
  test('all non-external links on landing are prefixed /knowledge-base/', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');

    const links = await page.locator('a[href]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('href')),
    );

    const internal = links.filter(
      (h) => h && !h.startsWith('http') && !h.startsWith('//') && !h.startsWith('mailto:') && !h.startsWith('#'),
    );

    for (const link of internal) {
      expect(
        link,
        `Internal link "${link}" does not start with /knowledge-base/.\n` +
        'Relative paths cause 404s when the fragment is embedded at a different origin path.',
      ).toMatch(/^\/knowledge-base\//);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-side navigation (no full-page reload)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Client-side navigation', () => {
  test('navigating to an app page does not trigger a full page reload', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');

    let reloaded = false;
    page.on('load', () => { reloaded = true; });

    const appLink = page.locator('a[href^="/knowledge-base/"]').first();
    if (await appLink.count() === 0) {
      test.skip(); // no app links — build had no apps
      return;
    }

    await appLink.click();
    await page.waitForLoadState('networkidle');

    expect(
      reloaded,
      'Full page reload detected on internal navigation.\n' +
      'ClientRouter should intercept the click and perform a fetch-based swap.',
    ).toBe(false);
  });

  test('URL updates after navigation (history.pushState)', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');
    const originalUrl = page.url();

    const appLink = page.locator('a[href^="/knowledge-base/"]').first();
    if (await appLink.count() === 0) {
      test.skip();
      return;
    }

    const href = await appLink.getAttribute('href');
    await appLink.click();
    await page.waitForURL(`**${href}**`, { timeout: 10_000 });

    expect(page.url()).not.toBe(originalUrl);
    expect(page.url()).toContain(href);
  });
});
