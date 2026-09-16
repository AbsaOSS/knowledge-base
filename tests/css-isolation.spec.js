/**
 * tests/css-isolation.spec.js
 *
 * The knowledge base's own CSS — masthead and catalog — must survive whatever
 * the web-fragments runtime does to the fragment's <head> across ClientRouter
 * navigation. reframed has lost, relocated and duplicated head <link>/<style>
 * nodes across versions (web-fragments #297); the symptom was a catalog
 * rendered under a docs theme after Library → app → Library, and a masthead
 * wearing two themes on the next app.
 *
 * Two defences, both exercised here against the embedded host:
 *
 *   • the knowledge base stylesheet is inlined into every <body>, so it is
 *     present exactly when its page is, regardless of what the head holds;
 *   • every sub-app stylesheet is wrapped in the `kb-app` cascade layer and the
 *     knowledge base's own regions are fenced (`.kb-shell`, layer `kb-reset`),
 *     so a sub-app sheet that does outlive its page cannot restyle them.
 *
 * The first suite reproduces the reported round trip; the second injects a
 * leak on purpose — the real fixture stylesheets plus a deliberately hostile
 * one — and checks the fence holds. See src/utils/css-layers.js.
 */

import { test, expect } from '@playwright/test';
import {
  gotoBoundFragment, gotoFragment, waitForFragmentText, fragmentFrame, queryInShadow, countInShadow,
  armFragmentProbe, fragmentProbe, hostStillAlive,
} from './support/fragment.js';

/** What the masthead and the catalog look like: computed style per selector. */
const SHELL_PROBES = {
  '#kb-masthead': ['display', 'background-color', 'border-bottom-width', 'padding-top'],
  '.kb-masthead-inner': ['max-width', 'padding-top', 'padding-left', 'box-sizing'],
  '.kb-masthead-badge': ['width', 'height', 'border-radius', 'background-color', 'color', 'display'],
  '.kb-masthead-badge svg': ['display', 'width', 'height'],
  '.kb-masthead-badge svg path': ['fill', 'stroke', 'stroke-width'],
  '.kb-masthead-kicker': ['font-size', 'font-weight', 'text-transform', 'letter-spacing', 'color'],
  '.kb-masthead-title': ['display', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'margin-top', 'margin-bottom', 'color', 'font-family'],
  '.kb-masthead-desc': ['display', 'font-size', 'line-height', 'max-width', 'margin-top', 'margin-bottom', 'color'],
  '.kb-masthead-nav': ['display', 'gap', 'margin-top', 'overflow-x'],
  '.kb-masthead-link': ['display', 'font-size', 'font-weight', 'padding-top', 'padding-left', 'color', 'text-decoration-line', 'border-bottom-width', 'border-bottom-color', 'background-color'],
  '.kb-masthead-brand': ['display', 'font-size', 'font-weight', 'color', 'padding-left'],
  'main#content': ['max-width', 'padding-top', 'padding-left', 'margin-left', 'box-sizing'],
  'main#content .grid': ['display', 'grid-template-columns', 'gap'],
  '.kb-card': ['display', 'flex-direction', 'background-color', 'border-top-width', 'border-top-color', 'border-radius', 'padding-top', 'box-shadow', 'text-decoration-line', 'color'],
  '.kb-card-icon': ['width', 'height', 'border-radius', 'background-color', 'margin-bottom', 'display'],
  '.kb-card h2': ['font-size', 'font-weight', 'margin-top', 'margin-bottom', 'line-height', 'color'],
  '.kb-card p': ['font-size', 'line-height', 'margin-top', 'margin-bottom', 'color'],
  '.kb-tag': ['display', 'font-size', 'padding-left', 'border-radius', 'background-color', 'color', 'border-top-width'],
  'footer': ['border-top-width', 'border-top-color', 'padding-top', 'font-size', 'color'],
};

/**
 * Computed styles of every probe present in the fragment's shadow tree.
 * Absent probes are reported as null so a snapshot from a catalog page and one
 * from an app page can still be compared on the masthead they share.
 */
async function shellSnapshot(page) {
  return page.evaluate((probes) => {
    function fragmentRoot(root) {
      if (root.querySelector('wf-document')) return root;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const f = fragmentRoot(el.shadowRoot); if (f) return f; }
      }
      return null;
    }
    const root = fragmentRoot(document);
    if (!root) return null;
    const out = {};
    for (const [selector, props] of Object.entries(probes)) {
      const el = root.querySelector(selector);
      if (!el) { out[selector] = null; continue; }
      const cs = getComputedStyle(el);
      out[selector] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    }
    return out;
  }, SHELL_PROBES);
}

/** The masthead's share of a snapshot — what an app page and the catalog have in common. */
const masthead = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => k.startsWith('#kb-masthead') || k.startsWith('.kb-masthead')));

async function clickInFragment(page, selector) {
  const link = page.locator(selector).first();
  await link.waitFor({ state: 'visible', timeout: 10_000 });
  await link.click();
}

const CARD = {
  userGuide: '.kb-card[href="/knowledge-base/user-guide/"]',
  guideMirror: '.kb-card[href="/knowledge-base/guide-mirror/"]',
};
const LIBRARY = '#kb-masthead a[href="/knowledge-base/"]';

async function waitForCatalog(page) {
  await waitForFragmentText(page, /Guide Mirror/);
  await expect.poll(() => queryInShadow(page, '.kb-card')).not.toBeNull();
}
async function waitForApp(page) {
  await expect.poll(() => queryInShadow(page, '#showcase-root')).not.toBeNull();
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('the knowledge base stylesheet travels with the page', () => {
  test('every page carries it inline in the body, none links it from the head', async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/');
    await waitForCatalog(page);
    const check = async () => {
      expect(await countInShadow(page, 'wf-body > style[data-kb-stylesheet]'), 'inline stylesheet count').toBe(1);
      expect(await countInShadow(page, 'link[rel~="stylesheet"][href*="/_astro/"]'), 'a head <link> to the knowledge base CSS').toBe(0);
    };
    await check();
    await clickInFragment(page, CARD.userGuide);
    await waitForApp(page);
    await check();
    await clickInFragment(page, LIBRARY);
    await waitForCatalog(page);
    await check();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
for (const [mode, open] of [['bound', gotoBoundFragment], ['unbound', gotoFragment]]) {
  test.describe(`Library → app → Library → app, ${mode} embedding`, () => {
    test('the catalog and the masthead are styled exactly as on first load after every hop', async ({ page }) => {
      await open(page, '/knowledge-base/');
      await waitForCatalog(page);
      const catalog = await shellSnapshot(page);
      expect(catalog['.kb-card'], 'baseline must see a card').not.toBeNull();
      expect(catalog['.kb-masthead-title'].display).toBe('block');
      // The baseline itself must be the intended design, not a consistently
      // broken one: the fence's `all: revert` must leave the icons' SVG
      // presentation attributes alone (they went solid black once).
      expect(catalog['.kb-masthead-badge svg path'].fill, 'badge icon must stay an outline').toBe('none');
      expect(catalog['.kb-masthead-badge svg path'].stroke, 'badge icon stroke is currentColor = kb-500').toBe('rgb(175, 20, 75)');
      expect(catalog['.kb-masthead-title']['font-size']).toBe('36px');
      expect(catalog['.kb-card']['border-radius']).toBe('16px');

      // Into an app: the masthead goes compact; remember how it looks there.
      await clickInFragment(page, CARD.userGuide);
      await waitForApp(page);
      await expect.poll(async () => (await shellSnapshot(page))['.kb-masthead-title'].display).toBe('none');
      const compact = masthead(await shellSnapshot(page));
      expect(compact['.kb-masthead-brand'].display).toBe('block');

      // Back to the Library: the round trip that used to mangle the catalog.
      await clickInFragment(page, LIBRARY);
      await waitForCatalog(page);
      await expect.poll(() => shellSnapshot(page), { timeout: 10_000 }).toEqual(catalog);

      // Into a different app: the masthead that used to wear two themes.
      await clickInFragment(page, CARD.guideMirror);
      await waitForApp(page);
      await expect.poll(async () => masthead(await shellSnapshot(page)), { timeout: 10_000 }).toEqual(compact);

      // And back once more.
      await clickInFragment(page, LIBRARY);
      await waitForCatalog(page);
      await expect.poll(() => shellSnapshot(page), { timeout: 10_000 }).toEqual(catalog);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The other direction: the sub-app's OWN pages must be styled after a chain of
// client navigations exactly as they are on a hard load. The reference is the
// hard load of the same URL, taken afterwards in the same browser, so the test
// pins no literal values — only that the ClientRouter path (head swap, body
// swap, layered sub-app stylesheet kept or re-fetched) ends in the same place
// the streaming path does.

/** Computed styles of the sub-app's content: the element after the masthead in wf-body. */
const APP_PROBES = {
  '': ['display', 'flex-direction', 'grid-template-columns', 'max-width', 'font-family', 'color'],
  'nav': ['display', 'position', 'width', 'background-color', 'border-right-width'],
  'nav a': ['display', 'color', 'font-size', 'padding-left', 'text-decoration-line'],
  'main': ['max-width', 'padding-left', 'padding-top', 'margin-left'],
  'h1': ['font-size', 'font-weight', 'line-height', 'margin-bottom', 'color', 'letter-spacing'],
  'h2': ['font-size', 'font-weight', 'margin-top', 'margin-bottom', 'color'],
  'p': ['font-size', 'line-height', 'margin-bottom', 'color'],
  'main a': ['color', 'text-decoration-line'],
  'ul': ['list-style-type', 'padding-left', 'margin-bottom'],
  'li': ['margin-bottom', 'display'],
  'code': ['font-family', 'font-size', 'background-color', 'padding-left', 'border-radius'],
  'pre': ['background-color', 'padding-top', 'border-radius', 'overflow-x', 'font-size'],
  'table': ['border-collapse', 'width'],
  'th': ['font-weight', 'text-align', 'border-bottom-width'],
  'img': ['max-width', 'display'],
  '.sc-hero': ['background-color', 'padding-top'],
  '.sc-hero__title': ['font-size', 'color', 'font-weight'],
};

async function appSnapshot(page) {
  return page.evaluate((probes) => {
    function fragmentRoot(root) {
      if (root.querySelector('wf-document')) return root;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const f = fragmentRoot(el.shadowRoot); if (f) return f; }
      }
      return null;
    }
    const root = fragmentRoot(document);
    if (!root) return null;
    // Stylesheet inventory: every link/style in the fragment tree, and whether
    // it is applied — a member of the shadow root's styleSheets with rules.
    // Not the rule count: a pierced page has every inline rule twice (reframed
    // re-inserts them when it portals the server-rendered host), and that
    // changes nothing about how the page renders.
    const applied = new Set([...root.styleSheets]);
    const sheets = [...root.querySelectorAll('link[rel~="stylesheet"], style')].map((n) => {
      let rules; try { rules = n.sheet ? n.sheet.cssRules.length : 0; } catch { rules = 'opaque'; }
      const id = n.getAttribute('href') ?? n.textContent.slice(0, 24).replace(/\s+/g, ' ');
      const state = !n.sheet ? 'no sheet' : !applied.has(n.sheet) ? 'NOT APPLIED' : rules === 0 ? 'empty' : 'applied';
      return `${n.localName}@${n.parentNode.localName ?? 'shadow'}:${id}:${state}${n.sheet?.disabled ? ':disabled' : ''}`;
    });
    // The sub-app's content: the first element after the masthead that is not a style.
    let app = root.querySelector('#kb-masthead')?.nextElementSibling;
    while (app && app.localName === 'style') app = app.nextElementSibling;
    const styles = {};
    for (const [selector, props] of Object.entries(probes)) {
      const el = selector ? app?.querySelector(selector) : app;
      if (!el) { styles[selector] = null; continue; }
      const cs = getComputedStyle(el);
      styles[selector] = Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
    }
    return { sheets, styles, h1: app?.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim() ?? null };
  }, APP_PROBES);
}

/** Waits for the sub-app content's own <h1> (the masthead has none on an app page). */
async function waitForAppH1(page, text) {
  await expect.poll(async () => (await appSnapshot(page))?.h1, { timeout: 15_000 }).toBe(text);
}

const DOCS = {
  overview: { path: '/knowledge-base/user-guide/docs/', h1: 'Knowledge Base Docs Example' },
  customising: { path: '/knowledge-base/user-guide/docs/customising/', h1: 'Customising the Template' },
  addingPages: { path: '/knowledge-base/user-guide/docs/adding-pages/', h1: 'Adding Pages' },
};

for (const [mode, open] of [['bound', gotoBoundFragment], ['unbound', gotoFragment]]) {
  test.describe(`docs pages reached by repeated client navigation, ${mode} embedding`, () => {
    test('catalog → showcase → docs → Customising → Adding Pages: each page styled as on a hard load', async ({ page }) => {
      test.setTimeout(90_000);
      await open(page, '/knowledge-base/');
      await waitForCatalog(page);
      // Sentinels on the host window and inside the reframed iframe, plus
      // counters for ClientRouter swaps and host-document view transitions:
      // every hop below must be a router transition, never a document load.
      await armFragmentProbe(page);

      const visited = [];
      const record = async (label, path) => {
        await page.waitForTimeout(500); // let the swap's stylesheet fetches settle
        const hops = visited.length + 1;
        expect(await hostStillAlive(page), `${label}: the host document reloaded`).toBe(true);
        const probe = await fragmentProbe(page);
        expect(probe.alive, `${label}: the reframed iframe was reloaded or recreated`).toBe(true);
        expect(probe.swaps, `${label}: ClientRouter swaps after ${hops} hop(s)`).toBe(hops);
        expect(probe.hostViewTransitions, `${label}: host view transitions after ${hops} hop(s)`).toBe(hops);
        const snap = await appSnapshot(page);
        expect(snap, `${label}: no fragment tree`).not.toBeNull();
        visited.push({ label, path, snap });
      };

      // Catalog card → the app's showcase index.
      await clickInFragment(page, CARD.userGuide);
      await waitForApp(page);
      await record('showcase', '/knowledge-base/user-guide/');

      // Showcase → the mkdocs part. The sub-app's own link, not the masthead's.
      await clickInFragment(page, `#showcase-root a[href="${DOCS.overview.path}"]`);
      await waitForAppH1(page, DOCS.overview.h1);
      await record('docs overview', DOCS.overview.path);

      // Sidebar hops within the docs.
      await clickInFragment(page, `a[href="${DOCS.customising.path}"]`);
      await waitForAppH1(page, DOCS.customising.h1);
      await record('customising', DOCS.customising.path);

      await clickInFragment(page, `a[href="${DOCS.addingPages.path}"]`);
      await waitForAppH1(page, DOCS.addingPages.h1);
      await record('adding pages', DOCS.addingPages.path);

      // Sanity on the last page, so a null-everywhere snapshot cannot pass.
      const last = visited.at(-1).snap;
      expect(last.styles['h1'], 'docs h1 not found').not.toBeNull();
      expect(last.styles['nav a'], 'docs sidebar link not found').not.toBeNull();
      expect(last.sheets.some((s) => s.includes('/user-guide/docs/style.css')), 'docs stylesheet missing after navigation').toBe(true);

      // Now the reference: every URL hard-loaded, and it must look the same.
      for (const { label, path, snap } of visited) {
        await open(page, path);
        if (path === '/knowledge-base/user-guide/') await waitForApp(page);
        else await waitForAppH1(page, Object.values(DOCS).find((d) => d.path === path).h1);
        await page.waitForTimeout(500);
        const hard = await appSnapshot(page);
        expect(snap.styles, `${label}: computed styles after client navigation differ from a hard load of ${path}`).toEqual(hard.styles);
        expect(snap.sheets, `${label}: stylesheet nodes after client navigation differ from a hard load of ${path}`).toEqual(hard.sheets);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
test.describe('a sub-app stylesheet that outlives its page', () => {
  /**
   * Simulates the reframed leak: on the catalog, append both fixture app
   * stylesheets AND a hostile sheet (what a docs theme's element rules look
   * like once the build has layered them) to the fragment's head, as if the
   * previous page's nodes had never been removed. A probe element outside
   * the fence proves the leak is real; the fence must not notice.
   */
  async function leakInto(page) {
    const frame = fragmentFrame(page);
    expect(frame, 'reframed wf:knowledge-base frame missing').not.toBeNull();
    await frame.evaluate(() => {
      for (const href of ['/knowledge-base/user-guide/docs/style.css', '/knowledge-base/user-guide/showcase.css']) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        link.setAttribute('data-kb-leak', '');
        document.head.appendChild(link);
      }
      const hostile = document.createElement('style');
      hostile.setAttribute('data-kb-leak', '');
      hostile.textContent = `@layer kb-app {
        * { box-sizing: content-box; }
        h1, h2, h3 { font-size: 77px; margin: 41px 0; color: rgb(255, 0, 0); text-decoration: underline; }
        p { margin: 33px; font-size: 29px; color: rgb(0, 128, 0); }
        a { color: rgb(0, 0, 255); text-decoration: underline; padding: 17px; display: block; }
        nav { display: none; }
        main { max-width: 100px; padding: 50px; }
        div { border: 5px dotted rgb(255, 0, 255); }
        svg { display: none; }
        .kb-leak-probe { color: rgb(255, 0, 0); }
      }`;
      document.head.appendChild(hostile);
      const probe = document.createElement('span');
      probe.className = 'kb-leak-probe';
      probe.textContent = 'probe';
      document.body.appendChild(probe);
    });
    await expect.poll(() => frame.evaluate(() =>
      [...document.querySelectorAll('link[data-kb-leak]')].every((l) => l.sheet !== null)), { timeout: 10_000 }).toBe(true);
  }

  test('cannot restyle the catalog or the masthead', async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/');
    await waitForCatalog(page);
    const before = await shellSnapshot(page);

    await leakInto(page);

    // The leak is real: outside the fence the hostile sheet applies…
    const probe = await fragmentFrame(page).evaluate(() => getComputedStyle(document.querySelector('.kb-leak-probe')).color);
    expect(probe, 'the injected sheet did not apply at all — the test proves nothing').toBe('rgb(255, 0, 0)');
    expect(await countInShadow(page, 'link[data-kb-leak]')).toBe(2);

    // …inside it, nothing moved.
    await page.waitForTimeout(300);
    expect(await shellSnapshot(page)).toEqual(before);
  });

  test('cannot restyle the masthead on an app page either, and the next catalog visit is clean', async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/');
    await waitForCatalog(page);
    const catalog = await shellSnapshot(page);

    await clickInFragment(page, CARD.guideMirror);
    await waitForApp(page);
    const compact = masthead(await shellSnapshot(page));

    await leakInto(page);
    await page.waitForTimeout(300);
    expect(masthead(await shellSnapshot(page))).toEqual(compact);

    await clickInFragment(page, LIBRARY);
    await waitForCatalog(page);
    await expect.poll(() => shellSnapshot(page), { timeout: 10_000 }).toEqual(catalog);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe('the layer order keeps the sub-app in charge of its own content', () => {
  test("a docs page's headings keep the theme's size — Preflight stays below the app's CSS", async ({ page }) => {
    await gotoBoundFragment(page, '/knowledge-base/user-guide/docs/');
    await expect.poll(() => queryInShadow(page, '#content h1')).not.toBeNull();
    const sizes = await page.evaluate(() => {
      function fragmentRoot(root) {
        if (root.querySelector('wf-document')) return root;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { const f = fragmentRoot(el.shadowRoot); if (f) return f; }
        }
        return null;
      }
      const root = fragmentRoot(document);
      const px = (el) => parseFloat(getComputedStyle(el).fontSize);
      return { h1: px(root.querySelector('#content h1')), body: px(root.querySelector('wf-body')) };
    });
    // Tailwind's Preflight sets h1 { font-size: inherit }; if it ever wins,
    // the heading collapses to body size.
    expect(sizes.h1, 'sub-app heading collapsed to body size — Preflight outranked the app CSS').toBeGreaterThan(sizes.body * 1.4);
  });
});
