/**
 * tests/web-fragment.spec.js
 *
 * Integration tests for the knowledge-base embedded as a web fragment inside the
 * test host shell (tests/host/server.mjs). Everything is driven through the HOST
 * origin (http://localhost:4201); the fragment is proxied onto that single origin
 * by the gateway, exactly as in production.
 *
 * Covers the four risk areas for this embedding:
 *   1. Shadow-DOM isolation (fragment reframed; host chrome must not leak in)
 *   2. Routing + smooth SPA transitions (fetch + swap, no host reload, history)
 *   3. Cross-app navigation between registered apps
 *   4. Asset loading on the host origin (no 404s; marketplace CSS resolves)
 */

import { test, expect } from '@playwright/test';
import {
  gotoFragment, waitForFragmentText, hostStillAlive,
  queryInShadow, getFragmentText, shadowHrefs, fragmentIsDark,
} from './support/fragment.js';

/** Attach a collector of same-origin (host) responses with status >= 400. */
function collectBadResponses(page) {
  const bad = [];
  page.on('response', (res) => {
    const url = res.url();
    if (!url.startsWith('http://localhost:4201/')) return; // ignore external (fonts, etc.)
    if (res.status() >= 400) bad.push(`${res.status()} ${url}`);
  });
  return bad;
}

/** Click a link inside the fragment (Playwright pierces open shadow roots). */
async function clickFragmentLink(page, selector) {
  const link = page.locator(selector).first();
  await link.waitFor({ state: 'visible', timeout: 10_000 });
  await link.click();
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Shadow-DOM isolation', () => {
  test.beforeEach(async ({ page }) => { await gotoFragment(page, '/knowledge-base/'); });

  test('host shell renders its own chrome in the light DOM', async ({ page }) => {
    const header = page.locator('#host-shell-header');
    await expect(header).toBeVisible();
    await expect(header).toContainText('Test Host Shell');
  });

  test('fragment renders as nested shadow roots (reframed)', async ({ page }) => {
    const nesting = await page.evaluate(() => {
      const wf = document.querySelector('web-fragment');
      const host = wf?.shadowRoot?.querySelector('web-fragment-host')
        ?? document.querySelector('web-fragment-host');
      return { hasFragment: !!wf, hasHost: !!host, hostHasShadow: !!host?.shadowRoot };
    });
    expect(nesting.hasFragment, '<web-fragment> not present').toBe(true);
    expect(nesting.hasHost, '<web-fragment-host> not present').toBe(true);
    expect(nesting.hostHasShadow, 'fragment host has no shadow root').toBe(true);
  });

  test('fragment document is in headless mode', async ({ page }) => {
    const el = await queryInShadow(page, '[data-mp-headless]');
    expect(el, 'data-mp-headless not found inside fragment').not.toBeNull();
  });

  test('fragment is light only (no dark class)', async ({ page }) => {
    expect(await fragmentIsDark(page)).toBe(false);
  });

  test('no chrome bar exists; the masthead is the fragment navigation', async ({ page }) => {
    // A fixed chrome bar escaped the shadow boundary and overlapped the host, so
    // it was removed outright — the masthead carries the navigation instead.
    expect(await queryInShadow(page, '#mp-chrome'), '#mp-chrome must not appear in fragment').toBeNull();
    expect(await queryInShadow(page, '#mp-masthead'), 'masthead missing from fragment').not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Landing catalog', () => {
  test.beforeEach(async ({ page }) => { await gotoFragment(page, '/knowledge-base/'); });

  test('shows both registered app cards', async ({ page }) => {
    const text = await getFragmentText(page);
    expect(text).toContain('User Guide');
    expect(text).toContain('Guide Mirror');
  });

  test('app card links are absolute /knowledge-base/ paths', async ({ page }) => {
    const hrefs = await shadowHrefs(page, '.mp-card');
    const internal = hrefs.filter(h => h && !h.startsWith('http') && !h.startsWith('#'));
    expect(internal.length).toBeGreaterThan(0);
    for (const h of internal) expect(h).toMatch(/^\/knowledge-base\//);
    expect(internal).toContain('/knowledge-base/user-guide/');
    expect(internal).toContain('/knowledge-base/guide-mirror/');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('In-app SPA navigation (smooth, no reload)', () => {
  test.beforeEach(async ({ page }) => { await gotoFragment(page, '/knowledge-base/user-guide/docs/'); });

  test('renders the docs sidebar with absolute links', async ({ page }) => {
    const nav = await queryInShadow(page, 'nav#sidebar');
    expect(nav, 'nav#sidebar not found in fragment').not.toBeNull();
    expect(nav.text).toMatch(/Overview|Customising/i);

    const hrefs = await shadowHrefs(page, 'nav#sidebar a[href]');
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h).toMatch(/^\/knowledge-base\/user-guide\//);
  });

  test('sidebar click swaps content via fetch — no full page reload', async ({ page }) => {
    let topLoads = 0;
    page.on('load', () => { topLoads++; });

    // ClientRouter fetches the target HTML (resourceType fetch/xhr) rather than
    // doing a document navigation — that is the smooth, no-reload transition.
    const navFetchP = page.waitForResponse(
      (res) => /\/knowledge-base\/user-guide\/docs\/customising\//.test(res.url())
        && ['fetch', 'xhr'].includes(res.request().resourceType()),
      { timeout: 10_000 },
    );

    await clickFragmentLink(page, 'nav#sidebar a[href*="customising"]');
    const navFetch = await navFetchP;
    expect(navFetch.status(), 'navigation fetch should succeed').toBeLessThan(400);

    await waitForFragmentText(page, /Customising/i);

    expect(await hostStillAlive(page), 'host window was reloaded during fragment nav').toBe(true);
    expect(topLoads, 'a full page reload occurred — SPA routing is broken').toBe(0);
  });

  test('fragment routing is internal to the reframed iframe and does not pollute top history', async ({ page }) => {
    // Known web-fragments behaviour (references/frameworks-astro.md): the fragment's
    // SPA history lives in the reframed `wf:<id>` iframe; it is intentionally NOT
    // mirrored to the top window. Consequences this test pins down:
    //   • the host URL + top history are untouched by fragment-internal navigation
    //     (so the browser back button does NOT deep-traverse fragment routes — and
    //      fragment routes are not address-bar deep-linkable), yet
    //   • the fragment router still tracks the navigation internally (smooth SPA).
    const beforeLen = await page.evaluate(() => history.length);
    const beforeUrl = page.url();

    // The fragment router DID navigate (content swapped to the Customising page)…
    await clickFragmentLink(page, 'nav#sidebar a[href*="customising"]');
    await waitForFragmentText(page, /Customising the Template/i);

    // …yet the top window's URL and history are untouched — fragment routing stays
    // inside the reframed iframe and is not mirrored up, so the browser back button
    // does not deep-traverse fragment routes (and they aren't address-bar linkable).
    expect(await page.evaluate(() => history.length),
      'fragment nav must not push top-window history entries').toBe(beforeLen);
    expect(page.url(), 'host URL must stay put during fragment-internal nav').toBe(beforeUrl);
    expect(await hostStillAlive(page), 'host must not reload').toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Cross-app navigation', () => {
  test('clicking the User Guide card navigates into that app', async ({ page }) => {
    await gotoFragment(page, '/knowledge-base/');
    await clickFragmentLink(page, '.mp-card[href="/knowledge-base/user-guide/"]');

    // Showcase/landing of the docs app.
    await waitForFragmentText(page, /Docs Example|MkDocs|Publish/i);
    expect(await hostStillAlive(page)).toBe(true);
  });

  test('clicking the Guide Mirror card navigates into the second app', async ({ page }) => {
    await gotoFragment(page, '/knowledge-base/');
    await clickFragmentLink(page, '.mp-card[href="/knowledge-base/guide-mirror/"]');

    // The mirror's internal links prove we are inside the guide-mirror slug.
    await page.waitForFunction(() => {
      function find(root) {
        if (root.querySelector('a[href*="/guide-mirror/"]')) return true;
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot && find(el.shadowRoot)) return true;
        return false;
      }
      return find(document);
    }, undefined, { timeout: 15_000 });

    const hrefs = await shadowHrefs(page, 'a[href*="/guide-mirror/"]');
    expect(hrefs.length, 'expected guide-mirror internal links after cross-app nav').toBeGreaterThan(0);
    expect(await hostStillAlive(page)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Asset loading on the host origin', () => {
  test('no 404s for fragment assets while browsing', async ({ page }) => {
    const bad = collectBadResponses(page);

    await gotoFragment(page, '/knowledge-base/');
    await gotoFragment(page, '/knowledge-base/user-guide/docs/');
    await clickFragmentLink(page, 'nav#sidebar a[href*="customising"]');
    await waitForFragmentText(page, /Customising/i);

    expect(bad, `host-origin requests returned errors:\n${bad.join('\n')}`).toEqual([]);
  });

  test('marketplace stylesheet resolves through the gateway', async ({ page }) => {
    // /__wf/knowledge-base/style.css → /knowledge-base/style.css → dist/style.css
    const res = await page.request.get('/knowledge-base/style.css');
    expect(res.status(), '/knowledge-base/style.css should resolve (200)').toBe(200);
    expect(res.headers()['content-type'] || '').toMatch(/css/);
  });
});
