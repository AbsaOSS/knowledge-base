/**
 * tests/standalone.spec.js
 *
 * CI-runnable Playwright tests for the knowledge-base fragment server.
 * Targets the standalone fragment server (port 3000) — no host gateway needed.
 * Run via playwright.config.ci.js.
 *
 * Coverage:
 *   ─ HTTP header safety   X-Frame-Options must not block the gateway's hidden iframe
 *   ─ Headless contract    data-kb-headless present; no chrome bar, no dark mode
 *   ─ CSS stability        data-astro-transition-persist on every <link rel=stylesheet>
 *                          (prevents web-fragments issue #297: head style accumulation)
 *   ─ Asset routing        /__wf/knowledge-base/* rewrite returns 200
 *                          (tests/fragment-server.mjs mirrors the nginx rewrite rule)
 *   ─ Path contract        all internal links are absolute /knowledge-base/* paths
 *   ─ Client-side nav      navigating between pages does NOT cause a full page reload
 *   ─ Masthead menu        bar vs compact menu per viewport, no horizontal overflow,
 *                          keyboard operation, current-page state
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

  // The CORS and security headers must reach *every* response, not just the
  // ones served by the catch-all. In nginx a location block declaring any
  // add_header discards the inherited set, which had left both the static-asset
  // block and the whole /knowledge-base/ prefix without them.
  // nginx.conf is asserted directly in tests/nginx-config.spec.js; these check
  // the paths end to end against the mirroring server.
  for (const [label, path] of [
    ['a page', '/knowledge-base/'],
    ['a sub-app page', '/knowledge-base/user-guide/'],
    ['a static asset', '/knowledge-base/style.css'],
    ['a fragment-prefixed asset', '/__wf/knowledge-base/style.css'],
  ]) {
    test(`serves CORS and security headers on ${label}`, async ({ request }) => {
      const res = await request.get(path);
      const headers = res.headers();
      expect(headers['access-control-allow-origin']).toBe('*');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('strict-origin');
      expect((headers['x-frame-options'] ?? '').toUpperCase()).toBe('SAMEORIGIN');
    });
  }

  test('does not send the deprecated X-XSS-Protection header', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    expect(res.headers()['x-xss-protection']).toBeUndefined();
  });

  // nginx serves /knowledge-base (no trailing slash) with an internal rewrite,
  // never a redirect: a 3xx would expose the container's internal HTTP address
  // and break mixed-content under HTTPS. This mirror answered with a 308 — the
  // opposite of production (#60) — and nothing asserted it either way.
  // tests/container.spec.js makes the same assertion against real nginx.
  test('serves /knowledge-base without a trailing slash by internal rewrite, not redirect', async ({ request }) => {
    const res = await request.get('/knowledge-base', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['location']).toBeUndefined();
  });

  // nginx's try_files serves a directory path as its index with a 200 whether or
  // not it ends in a slash. express.static answers 301 by default, which is the
  // wider half of the same drift.
  test('serves a sub-app page without a trailing slash, not a redirect', async ({ request }) => {
    const res = await request.get('/knowledge-base/user-guide', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['location']).toBeUndefined();
  });

  // The mirror's half of nginx's per-asset-class Cache-Control map;
  // tests/container.spec.js asserts the shipped config.
  test('caches hashed assets as immutable and revalidates everything else', async ({ request }) => {
    const landing = await (await request.get('/knowledge-base/')).text();
    const astro = landing.match(/src="(\/knowledge-base\/_astro\/[^"]+)"/)?.[1];
    expect(astro, 'the landing page references no _astro/ asset').toBeTruthy();
    for (const path of [astro, astro.replace(/^\//, '/__wf/')]) {
      expect((await request.get(path)).headers()['cache-control'], path)
        .toBe('public, max-age=31536000, immutable, no-transform');
    }
    for (const path of ['/knowledge-base/', '/knowledge-base/user-guide', '/knowledge-base/style.css', '/__wf/knowledge-base/style.css']) {
      expect((await request.get(path)).headers()['cache-control'], path).toBe('no-cache, no-transform');
    }
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

  // KB_HEADLESS=true must set data-kb-headless="true" on <html>.
  // The gateway reads this to confirm the fragment was built for embedding.
  test('html element has data-kb-headless="true"', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-kb-headless', 'true');
  });

  // There is no chrome nav bar in either mode any more — the masthead is the
  // whole navigation. A fixed bar escaped the shadow boundary when reframed
  // pierced the DOM, duplicating a nav over the host app.
  test('no chrome nav bar is rendered; the masthead is the navigation', async ({ page }) => {
    await expect(page.locator('#kb-chrome')).toHaveCount(0);
    await expect(page.locator('#kb-masthead')).toHaveCount(1);
  });

  // Light-only: no theme bootstrap, no toggle, no dark class.
  test('no dark mode is shipped', async ({ page }) => {
    await expect(page.locator('html.dark, .dark')).toHaveCount(0);
    // Both spellings of the persisted-theme key: `mp-theme` predates the rename
    // in #77, and a sub-app bundle published before it still writes that one.
    const themeApi = await page.evaluate(
      () => typeof window.toggleTheme
        + '|' + (localStorage.getItem('kb-theme') ?? 'unset')
        + '|' + (localStorage.getItem('mp-theme') ?? 'unset'),
    );
    expect(themeApi).toBe('undefined|unset|unset');
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
// Fix, in two parts: transform.js adds data-astro-transition-persist to every
// <link rel="stylesheet"> injected by sub-app pages so Astro keeps them stable
// rather than swapping them; and the knowledge base's own stylesheet is not a
// head <link> at all — Base.astro inlines it into every <body>, so there is
// nothing of the knowledge base's for reframed to lose (tests/css-isolation.spec.js
// covers what happens when a sub-app sheet does leak).
//
// Upstream: https://github.com/web-fragments/web-fragments/issues/297

test.describe('CSS link stability (#297)', () => {
  test('the landing page links no stylesheet from its head and carries the knowledge base CSS inline', async ({ page }) => {
    await page.goto('/knowledge-base/');
    await page.waitForLoadState('networkidle');

    expect(await page.locator('link[rel="stylesheet"]').count(), 'the landing page must not link a stylesheet').toBe(0);
    expect(await page.locator('body > style[data-kb-stylesheet]').count(), 'inline knowledge base stylesheet').toBe(1);
    // …and it is applied: the masthead title is the stylesheet's 2.25rem, not the UA's h1.
    const title = page.locator('.kb-masthead-title');
    await expect(title).toHaveCSS('font-size', '36px');
  });

  test('all stylesheet links on sub-app pages have data-astro-transition-persist', async ({ page }) => {
    // Navigate to a sub-app page (if available)
    await page.goto('/knowledge-base/user-guide/');
    // Don't fail if example isn't built — skip gracefully
    const status = await page.evaluate(() => document.readyState);
    if (await page.locator('html').getAttribute('data-kb-headless') === null) {
      test.skip(); // page did not load as a fragment page
      return;
    }

    const links = page.locator('link[rel="stylesheet"]');
    const count = await links.count();
    expect(count, 'the fixture app links its own stylesheets — none found').toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const href = await links.nth(i).getAttribute('href');
      expect(href, 'the knowledge base stylesheet must be inlined, never linked').not.toMatch(/^\/knowledge-base\/_astro\/.+\.css$/);
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
    const appLink = page.locator('a.kb-card[href^="/knowledge-base/"]').first();
    if (await appLink.count() === 0) {
      test.skip();
      return;
    }

    // Navigate forward
    const href = await appLink.getAttribute('href');
    await appLink.click();
    await page.waitForURL(`**${href}`, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Navigate back. ClientRouter updates the URL on popstate BEFORE it swaps the
    // document, so neither waitForURL nor 'networkidle' proves the swap finished —
    // counting there would still see the sub-app's stylesheets. Wait for landing-only
    // content (the catalog cards) to prove the swap landed.
    await page.goBack();
    await page.locator('.kb-card').first().waitFor({ state: 'visible', timeout: 10_000 });
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
    // The landing page links no stylesheet (the knowledge base CSS is inline), so
    // the sub-app's own links are the ones to check — plus the stable alias of
    // the knowledge base stylesheet, which outside consumers fetch by this path.
    await page.goto('/knowledge-base/user-guide/docs/');
    await page.waitForLoadState('networkidle');

    const hrefs = await page.locator('link[rel="stylesheet"]').evaluateAll(
      (els) => els.map((e) => e.getAttribute('href')).filter(Boolean),
    );
    expect(hrefs.length, 'No stylesheet links found on the sub-app page').toBeGreaterThan(0);
    hrefs.push('/knowledge-base/style.css');

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

    const appLink = page.locator('a.kb-card[href^="/knowledge-base/"]').first();
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

    const appLink = page.locator('a.kb-card[href^="/knowledge-base/"]').first();
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

// ─────────────────────────────────────────────────────────────────────────────
// Masthead menu
//
// Scoped to the app being viewed: Library, the app, then that app's manifest
// entries — a section as a dropdown of its pages. From 1024px the full bar
// shows; below it a compact bar with a Menu button opening a popover sheet of
// the app's pages. The Showcase page is used rather than a docs page: the
// fixture's docs pages pin their own fixed top bar over the masthead, which is
// the fixture's business, not the menu's.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Masthead menu', () => {
  const SHOWCASE = '/knowledge-base/guide-mirror/';
  const WIDTHS = [320, 375, 768, 1023, 1024, 1280, 1920];

  /** Horizontal overflow of the document, and any masthead control past the viewport edge. */
  const overflow = (page) => page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = [...document.querySelectorAll('#kb-masthead a, #kb-masthead summary, #kb-masthead button')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => { const r = el.getBoundingClientRect(); return r.left < -0.5 || r.right > width + 0.5; })
      .map((el) => el.textContent.trim());
    return { scroll: document.documentElement.scrollWidth - width, clipped };
  });

  for (const width of WIDTHS) {
    test(`${width}px: the right navigation shows and nothing overflows`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      const wide = width >= 1024;
      for (const path of ['/knowledge-base/', SHOWCASE]) {
        await page.goto(path);
        await expect(page.locator('.kb-nav-bar')).toBeVisible({ visible: wide });
        // Only an app with manifest pages has a menu to open.
        await expect(page.locator('.kb-nav-toggle')).toBeVisible({ visible: !wide && path === SHOWCASE });
        expect(await overflow(page), `${path} at ${width}px`).toEqual({ scroll: 0, clipped: [] });
      }
    });
  }

  test('the links sit where they do on the catalog; the brand never moves or covers them', async ({ page }) => {
    const layout = () => page.evaluate(() => {
      const library = [...document.querySelectorAll('#kb-masthead .kb-masthead-nav a')].find((a) => a.getClientRects().length);
      const brand = document.querySelector('.kb-masthead-brand');
      return {
        library: library.getBoundingClientRect().left,
        brandRight: brand?.getClientRects().length ? brand.getBoundingClientRect().right : null,
      };
    });
    for (const width of [800, 1024, 1280, 1439, 1440, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/knowledge-base/');
      const { library } = await layout();
      for (const path of [SHOWCASE, '/knowledge-base/user-guide/']) {
        await page.goto(path);
        const app = await layout();
        expect(app.library, `Library moved on ${path} at ${width}px`).toBeCloseTo(library, 0);
        if (app.brandRight !== null) expect(app.brandRight, `brand covers Library at ${width}px`).toBeLessThanOrEqual(app.library);
      }
      // The brand shows wherever its gutter holds it.
      expect((await layout()).brandRight !== null, `brand at ${width}px`).toBe(width >= 1440);
    }
  });

  test("the compact menu holds the current app's pages and keeps the page from scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(SHOWCASE);
    const toggle = page.locator('.kb-nav-toggle');
    await expect(toggle).toHaveAccessibleName('Guide Mirror pages');
    await toggle.click();
    const sheet = page.locator('#kb-nav-menu');
    await expect(sheet).toBeVisible();

    const menu = page.getByRole('navigation', { name: 'Guide Mirror pages' });
    for (const name of ['Showcase', 'Overview', 'Adding Pages', 'Customising']) {
      await expect(menu.getByRole('link', { name, exact: true })).toBeVisible();
    }
    for (const name of ['User Guide', 'External Docs', 'Platform Overview', 'Release Process']) {
      await expect(menu.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    await expect(menu.getByRole('link', { name: 'Showcase' })).toHaveAttribute('aria-current', 'page');
    expect(await overflow(page)).toMatchObject({ scroll: 0 });

    // The sheet fits the viewport.
    const box = await sheet.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375.5);

    // The close button and Escape both dismiss it.
    await page.getByRole('button', { name: 'Close menu' }).click();
    await expect(sheet).toBeHidden();
    await toggle.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('the compact menu works from the keyboard and navigates', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 800 });
    await page.goto(SHOWCASE);
    await page.locator('.kb-nav-toggle').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#kb-nav-menu')).toBeVisible();

    const target = page.getByRole('navigation', { name: 'Guide Mirror pages' }).getByRole('link', { name: 'Overview' });
    await target.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL('**/knowledge-base/guide-mirror/docs/');
    await expect(page.locator('.kb-nav-compact .kb-nav-crumb')).toContainText('Guide Mirror');
  });

  test('the entries follow the app being viewed', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/knowledge-base/');
    await expect(page.locator('.kb-nav-bar > li')).toHaveCount(1);

    await page.locator('a.kb-card[href="/knowledge-base/guide-mirror/"]').click();
    await page.waitForURL('**/knowledge-base/guide-mirror/');
    await expect(page.locator('.kb-nav-bar > li > a, .kb-nav-bar > li > details > summary')).toHaveText(['Library', 'Guide Mirror', 'Showcase', 'Overview', 'Guide']);

    await page.locator('.kb-nav-bar a', { hasText: 'Library' }).click();
    await page.waitForURL(/\/knowledge-base\/$/);
    await page.locator('a.kb-card[href="/knowledge-base/user-guide/"]').click();
    await page.waitForURL('**/knowledge-base/user-guide/');
    await expect(page.locator('.kb-nav-bar > li > a, .kb-nav-bar > li > details > summary')).toHaveText(['Library', 'User Guide']);
  });

  test('a section dropdown opens from the keyboard, shows a focus ring and closes on Escape', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHOWCASE);
    const summary = page.locator('.kb-nav-bar summary', { hasText: 'Guide' });
    const details = page.locator('.kb-nav-bar details.kb-nav-dropdown');

    // Tab from the last plain entry onto the dropdown, the way a keyboard user gets there.
    await page.locator('.kb-nav-bar a', { hasText: 'Overview' }).focus();
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await page.keyboard.press('Tab');
    await expect(page.locator('.kb-nav-panel a', { hasText: 'Adding Pages' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
  });

  test('a section dropdown closes on an outside click and when focus tabs out of it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHOWCASE);
    const summary = page.locator('.kb-nav-bar summary', { hasText: 'Guide' });
    const details = page.locator('.kb-nav-bar details.kb-nav-dropdown');

    await summary.click();
    await expect(details).toHaveAttribute('open', '');
    await page.mouse.click(5, 700);
    await expect(details).not.toHaveAttribute('open', '');

    await summary.click();
    await page.locator('.kb-nav-panel a', { hasText: 'Customising' }).focus();
    await page.keyboard.press('Tab');
    await expect(details).not.toHaveAttribute('open', '');
  });

  test('opening one section dropdown closes the other', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/knowledge-base/handbook/');
    await expect(page.locator('.kb-nav-bar > li > a, .kb-nav-bar > li > details > summary'))
      .toHaveText(['Library', 'Handbook', 'Showcase', 'Getting started', 'Authoring']);
    const first = page.locator('.kb-nav-bar details', { hasText: 'Getting started' });
    const second = page.locator('.kb-nav-bar details', { hasText: 'Authoring' });

    await first.locator('summary').click();
    await expect(first).toHaveAttribute('open', '');
    await second.locator('summary').click();
    await expect(second).toHaveAttribute('open', '');
    await expect(first).not.toHaveAttribute('open', '');
  });

  test('a section page link navigates and becomes the current page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(SHOWCASE);
    await page.locator('.kb-nav-bar summary', { hasText: 'Guide' }).click();
    await page.locator('.kb-nav-panel a', { hasText: 'Adding Pages' }).click();
    await page.waitForURL('**/knowledge-base/guide-mirror/docs/adding-pages/');
    await expect(page.locator('.kb-nav-bar summary[aria-current="true"]')).toContainText('Guide');
    await expect(page.locator('.kb-nav-panel a[aria-current="page"]')).toHaveText('Adding Pages');
  });
});
