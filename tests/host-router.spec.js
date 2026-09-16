/**
 * tests/host-router.spec.js
 *
 * The fragment's client router (Astro's <ClientRouter />) living next to the
 * HOST's router — in production an Angular Router. The host shell loads an
 * Angular Router stand-in (tests/host/host-router.js) that owns the address
 * bar, listens to popstate and reuses or recreates the outlet exactly as
 * Angular does, so these tests pin down both ways of embedding:
 *
 *   • UNBOUND — <web-fragment src="…">. Fragment history is sandboxed inside
 *               the reframed iframe. The host URL never moves and the host
 *               router never hears about fragment navigation. The price: no
 *               back/forward and no deep links for fragment pages.
 *   • BOUND   — <web-fragment> without src. The fragment's history IS the host
 *               history: every ClientRouter pushState surfaces as a host
 *               popstate, the host router re-routes and — with a wildcard route
 *               covering /knowledge-base/** — reuses the outlet, so the fragment
 *               survives. Deep links and browser back/forward work.
 *
 * "Smooth" in every test means: the host document never reloads, the reframed
 * iframe is never recreated (its JS state survives), the swap is done by the
 * ClientRouter (`astro:after-swap` fires once per navigation), a view
 * transition runs on the HOST document (the one a visitor can see), the wf-*
 * tree stays one level deep, and no stylesheet is duplicated along the way —
 * see src/scripts/embedded-transitions.js for the two corrections behind that.
 */

import { test, expect } from '@playwright/test';
import {
  gotoFragment, gotoBoundFragment, waitForFragmentText, waitForFragmentReady, hostStillAlive,
  hostRouterLog, hostNavigate, fragmentFrame, armFragmentProbe, fragmentProbe,
  countInShadow, queryInShadow, fragmentH1,
} from './support/fragment.js';

const DOCS = '/knowledge-base/user-guide/docs/';
const LINK = {
  overview: 'nav#sidebar a[href$="/user-guide/docs/"]',
  customising: 'nav#sidebar a[href*="customising"]',
  addingPages: 'nav#sidebar a[href*="adding-pages"]',
};
const H1 = {
  overview: 'Knowledge Base Docs Example',
  customising: 'Customising the Template',
  addingPages: 'Adding Pages',
};

async function clickFragmentLink(page, selector) {
  const link = page.locator(selector).first();
  await link.waitFor({ state: 'visible', timeout: 10_000 });
  await link.click();
}

/** Waits for the sub-app page heading — the sidebar and top nav repeat page titles, body text does not do. */
async function waitForH1(page, text) {
  await expect.poll(() => fragmentH1(page), { timeout: 15_000 }).toBe(text);
}

async function pathname(page) {
  return new URL(page.url()).pathname;
}

/** Stylesheet + inline style nodes anywhere in the fragment's shadow tree. */
async function styleNodeCount(page) {
  return countInShadow(page, 'link[rel~="stylesheet"], style');
}

async function expectSmoothNavigation(page, { swaps }) {
  expect(await hostStillAlive(page), 'host document reloaded').toBe(true);
  const probe = await fragmentProbe(page);
  expect(probe.alive, 'reframed iframe was reloaded or recreated').toBe(true);
  expect(probe.swaps, 'ClientRouter swaps').toBe(swaps);
  expect(probe.hostViewTransitions, 'view transitions run on the host document').toBe(swaps);
}

/** Three hops (a → b → c → a) must leave the fragment's tree and head exactly as they were. */
async function expectNoLeakAcrossThreeHops(page) {
  const baselineStyles = await styleNodeCount(page);
  expect(baselineStyles).toBeGreaterThan(0);
  expect(await countInShadow(page, 'wf-html')).toBeLessThanOrEqual(1);

  await clickFragmentLink(page, LINK.customising);
  await waitForH1(page, H1.customising);
  await clickFragmentLink(page, LINK.addingPages);
  await waitForH1(page, H1.addingPages);
  await clickFragmentLink(page, LINK.overview);
  await waitForH1(page, H1.overview);
  await expectSmoothNavigation(page, { swaps: 3 });

  expect(await countInShadow(page, 'wf-html'), 'a new wf-html was nested per navigation').toBe(1);
  expect(await countInShadow(page, 'wf-body'), 'a new wf-body was nested per navigation').toBe(1);
  expect(await styleNodeCount(page), 'style nodes grew across a → b → c → a').toBe(baselineStyles);
  expect(await queryInShadow(page, 'wf-html[data-kb-headless="true"]'), 'root attributes lost in the swap').not.toBeNull();
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Unbound fragment (src set): host router owns the address bar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoFragment(page, DOCS);
    await armFragmentProbe(page);
  });

  test('host router mounted the fragment on its own route', async ({ page }) => {
    const log = await hostRouterLog(page);
    expect(log.activations).toEqual(['kb']);
    expect(log.navigations[0]).toMatchObject({ source: 'initial', component: 'kb' });
    expect(fragmentFrame(page), 'reframed wf:knowledge-base frame missing').not.toBeNull();
  });

  test('fragment navigation is smooth and invisible to the host router', async ({ page }) => {
    const before = await hostRouterLog(page);
    const url = page.url();

    await clickFragmentLink(page, LINK.customising);
    await waitForH1(page, H1.customising);
    await expectSmoothNavigation(page, { swaps: 1 });

    const after = await hostRouterLog(page);
    expect(after.popstates, 'host must not receive popstate from fragment nav').toBe(before.popstates);
    expect(after.navigations.length, 'host router must not navigate').toBe(before.navigations.length);
    expect(page.url(), 'host URL must not move').toBe(url);
  });

  test('history.back() inside the fragment is a no-op: unbound history cannot be traversed', async ({ page }) => {
    // reframed gives an unbound fragment a private history stack whose back()
    // only rewrites the iframe URL — no popstate, so the ClientRouter never
    // navigates. Pinned here because it is the trade-off of this mode: the
    // browser's back button belongs to the host, and there is no fragment one.
    await clickFragmentLink(page, LINK.customising);
    await waitForH1(page, H1.customising);
    const url = page.url();

    await fragmentFrame(page).evaluate(() => history.back());
    await page.waitForTimeout(500);

    expect(await fragmentH1(page)).toBe(H1.customising);
    await expectSmoothNavigation(page, { swaps: 1 });
    expect((await hostRouterLog(page)).popstates).toBe(0);
    expect(page.url()).toBe(url);
  });

  test('three hops leave one wf-html and no duplicated stylesheet', async ({ page }) => {
    await expectNoLeakAcrossThreeHops(page);
  });

  test('host navigating away unmounts the fragment; coming back remounts it', async ({ page }) => {
    await hostNavigate(page, '/host-home');
    await expect(page.locator('#host-home')).toBeVisible();
    expect(await page.locator('web-fragment').count(), 'fragment element must be removed').toBe(0);
    await expect.poll(() => fragmentFrame(page), 'reframed iframe must be torn down').toBeNull();
    expect(await pathname(page)).toBe('/host-home');

    await hostNavigate(page, '/');
    await waitForFragmentReady(page);
    expect(await hostStillAlive(page)).toBe(true);
    expect((await fragmentProbe(page)).alive, 'a fresh fragment must not carry the old sentinel').toBe(false);
    expect(await queryInShadow(page, '#kb-masthead')).not.toBeNull();
    expect((await hostRouterLog(page)).activations).toEqual(['kb', 'home', 'kb']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('Bound fragment (no src): fragment routes live in the address bar', () => {
  test('deep link renders the fragment at the requested route', async ({ page }) => {
    await gotoBoundFragment(page, DOCS);
    await waitForH1(page, H1.overview);

    const log = await hostRouterLog(page);
    expect(log.activations).toEqual(['kb']);
    expect(log.navigations[0]).toMatchObject({ source: 'initial', component: 'kb', reused: false });
    // Angular's Location normalises the path: the trailing slash is gone from
    // the address bar, and the fragment still resolves the page.
    expect(await pathname(page)).toBe('/knowledge-base/user-guide/docs');
    expect(await queryInShadow(page, 'nav#sidebar')).not.toBeNull();
  });

  test('in-app navigation moves the host URL and the host router reuses the outlet', async ({ page }) => {
    await gotoBoundFragment(page, DOCS);
    await armFragmentProbe(page);
    const before = await hostRouterLog(page);

    await clickFragmentLink(page, LINK.customising);
    await waitForH1(page, H1.customising);
    await expect.poll(() => pathname(page)).toBe('/knowledge-base/user-guide/docs/customising');
    await expectSmoothNavigation(page, { swaps: 1 });

    await expect.poll(async () => (await hostRouterLog(page)).navigations.length).toBe(before.navigations.length + 1);
    const after = await hostRouterLog(page);
    expect(after.popstates).toBeGreaterThan(before.popstates);
    expect(after.navigations.at(-1)).toMatchObject({
      source: 'popstate', component: 'kb', reused: true,
      url: '/knowledge-base/user-guide/docs/customising',
    });
    expect(after.activations, 'outlet must not be re-rendered').toEqual(['kb']);
  });

  test('browser back and forward traverse fragment pages without reloading', async ({ page }) => {
    await gotoBoundFragment(page, DOCS);
    await armFragmentProbe(page);
    await clickFragmentLink(page, LINK.customising);
    await waitForH1(page, H1.customising);

    await page.goBack();
    await waitForH1(page, H1.overview);
    await expect.poll(() => pathname(page)).toBe('/knowledge-base/user-guide/docs');
    await expectSmoothNavigation(page, { swaps: 2 });

    await page.goForward();
    await waitForH1(page, H1.customising);
    await expect.poll(() => pathname(page)).toBe('/knowledge-base/user-guide/docs/customising');
    await expectSmoothNavigation(page, { swaps: 3 });

    const log = await hostRouterLog(page);
    expect(log.activations).toEqual(['kb']);
    for (const nav of log.navigations.slice(1)) expect(nav).toMatchObject({ source: 'popstate', reused: true });
  });

  test('masthead and catalog navigation across apps keeps the outlet', async ({ page }) => {
    await gotoBoundFragment(page, DOCS);
    await armFragmentProbe(page);

    // App crumb → the app's own index page.
    await clickFragmentLink(page, '#kb-masthead a[href="/knowledge-base/user-guide/"]');
    await expect.poll(() => queryInShadow(page, '#showcase-root')).not.toBeNull();
    await expect.poll(() => pathname(page)).toBe('/knowledge-base/user-guide');

    // Library → the catalog.
    await clickFragmentLink(page, '#kb-masthead a[href="/knowledge-base/"]');
    await waitForFragmentText(page, /Guide Mirror/);
    await expect.poll(() => pathname(page)).toBe('/knowledge-base');

    // Catalog card → a different app.
    await clickFragmentLink(page, '.kb-card[href="/knowledge-base/guide-mirror/"]');
    await expect.poll(() => queryInShadow(page, '#showcase-root')).not.toBeNull();
    await expect.poll(() => pathname(page)).toBe('/knowledge-base/guide-mirror');

    await expectSmoothNavigation(page, { swaps: 3 });
    expect((await hostRouterLog(page)).activations).toEqual(['kb']);
  });

  test('three hops leave one wf-html and no duplicated stylesheet', async ({ page }) => {
    await gotoBoundFragment(page, DOCS);
    await armFragmentProbe(page);
    await expectNoLeakAcrossThreeHops(page);
  });

  test('host navigation away and back through the host router', async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/');
    await armFragmentProbe(page);

    await page.locator('#host-nav-home').click();
    await expect(page.locator('#host-home')).toBeVisible();
    expect(await pathname(page)).toBe('/bound');
    expect(await page.locator('web-fragment').count()).toBe(0);
    await expect.poll(() => fragmentFrame(page)).toBeNull();

    await page.locator('#host-nav-kb').click();
    await waitForFragmentReady(page);
    expect(await pathname(page)).toBe('/knowledge-base');
    expect(await hostStillAlive(page)).toBe(true);
    expect((await fragmentProbe(page)).alive, 'remounted fragment is a fresh iframe').toBe(false);
    expect((await hostRouterLog(page)).activations).toEqual(['kb', 'home', 'kb']);

    // The remounted fragment navigates smoothly again.
    await armFragmentProbe(page);
    await clickFragmentLink(page, '.kb-card[href="/knowledge-base/user-guide/"]');
    await expect.poll(() => queryInShadow(page, '#showcase-root')).not.toBeNull();
    await expectSmoothNavigation(page, { swaps: 1 });
  });

  test('a host route that covers only the entry URL tears the fragment down on first click', async ({ page }) => {
    // The clash this suite exists to prevent: Angular route `knowledge-base`
    // without a `**` child. The fragment's first pushState lands on a URL the
    // host router cannot match, so it activates its 404 and destroys the outlet.
    await gotoBoundFragment(page, '/knowledge-base/', { hostRoutes: 'narrow' });
    await armFragmentProbe(page);

    await clickFragmentLink(page, '.kb-card[href="/knowledge-base/user-guide/"]');

    await expect(page.locator('#host-not-found')).toBeVisible();
    await expect.poll(() => fragmentFrame(page)).toBeNull();
    const log = await hostRouterLog(page);
    expect(log.navigations.at(-1)).toMatchObject({ source: 'popstate', component: 'notFound', reused: false });
    expect(log.activations).toEqual(['kb', 'notFound']);
  });
});
