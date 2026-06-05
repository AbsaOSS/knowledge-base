/**
 * tests/marketplace.spec.js
 *
 * Integration tests for the knowledge-base web-fragment embedded inside
 * data-gateway at https://localhost:4201/knowledge-base.
 *
 * Architecture under test:
 *   data-gateway (Angular SSR, :4201)
 *     └─ <web-fragment fragment-id="knowledge-base">
 *          └─ hidden iframe → http://localhost:3000/knowledge-base/
 *               └─ DOM reframed into <web-fragment-host> shadow root
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shadow DOM helpers
// ---------------------------------------------------------------------------

/**
 * Recursively searches all shadow roots for an element matching `selector`.
 * Returns the element's outerHTML or null.
 */
async function queryInShadow(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      const el = root.querySelector(sel);
      if (el) return el;
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot) {
          const found = search(child.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    const el = search(document);
    return el ? { html: el.outerHTML, text: el.textContent?.trim() } : null;
  }, selector);
}

/**
 * Waits for a selector to appear in any shadow root.
 */
async function waitForInShadow(page, selector, { timeout = 15_000 } = {}) {
  await page.waitForFunction(
    (sel) => {
      function search(root) {
        if (root.querySelector(sel)) return true;
        for (const child of root.querySelectorAll('*')) {
          if (child.shadowRoot && search(child.shadowRoot)) return true;
        }
        return false;
      }
      return search(document);
    },
    selector,
    { timeout },
  );
}

/**
 * Gets all text content inside the fragment (shadow DOM).
 * Searches through all shadow roots recursively to find the fragment content.
 */
async function getFragmentText(page) {
  return page.evaluate(() => {
    function getAllText(root) {
      return root.textContent?.replace(/\s+/g, ' ').trim() || '';
    }

    function search(root, depth = 0) {
      if (depth > 10) return null;

      // web-fragment-host contains the reframed content in its shadow root
      const hosts = root.querySelectorAll('web-fragment-host');
      for (const host of hosts) {
        if (host.shadowRoot) {
          const text = getAllText(host.shadowRoot);
          if (text) return text;
        }
      }

      // Fallback: search any element with a shadow root
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot) {
          const result = search(child.shadowRoot, depth + 1);
          if (result) return result;
        }
      }
      return null;
    }
    return search(document);
  });
}

/**
 * Gets the inner frame (iframe managed by web-fragments for JS isolation).
 */
async function getFragmentFrame(page) {
  // Wait for the fragment iframe to appear and contain our content
  const frames = page.frames();
  return frames.find(f => f.url().includes('/knowledge-base')) || null;
}

/**
 * Clicks an element inside the fragment's shadow DOM.
 * Dispatches a native click event so the fragment router can intercept it.
 */
async function clickInShadow(page, selector) {
  return page.evaluate((sel) => {
    function search(root) {
      const el = root.querySelector(sel);
      if (el) {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot && search(child.shadowRoot)) return true;
      }
      return false;
    }
    return search(document);
  }, selector);
}

/**
 * Clicks an anchor inside the fragment's shadow DOM using Playwright's built-in
 * shadow-DOM piercing. Returns true if the element was found and clicked.
 *
 * Note: the fragment's visible DOM lives in the <web-fragment-host> shadow root —
 * the hidden iframe only holds the "Web Fragments: reframed" placeholder and has
 * no content links, so frame.click() would never find elements there.
 */
async function clickFragmentLink(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  await locator.click();
  return true;
}

/**
 * Navigate to a route and wait until the fragment's inner content is ready.
 */
async function gotoFragment(page, path) {
  await page.goto(path);
  // Wait for the Angular app to render the fragment placeholder
  await page.waitForSelector('[data-testid="knowledge-base-web-fragment"], web-fragment', {
    state: 'attached',
    timeout: 10_000,
  }).catch(() => { /* component might not have testid — continue */ });
  // Then wait for actual fragment content to appear in shadow DOM
  await waitForInShadow(page, '[data-mp-headless]', { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('knowledge-base web-fragment', () => {

  // ── Landing page ──────────────────────────────────────────────────────────

  test.describe('Landing page', () => {
    test.beforeEach(async ({ page }) => {
      await gotoFragment(page, '/knowledge-base/');
    });

    test('renders in headless mode (data-mp-headless attribute present)', async ({ page }) => {
      const el = await queryInShadow(page, '[data-mp-headless]');
      expect(el, 'Fragment root element with data-mp-headless not found').not.toBeNull();
    });

    test('is in light mode (no dark class on html element)', async ({ page }) => {
      const hasDark = await page.evaluate(() => {
        function search(root) {
          const html = root.querySelector('html, wf-html');
          if (html) return html.classList.contains('dark');
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) {
              const result = search(child.shadowRoot);
              if (result !== null) return result;
            }
          }
          return null;
        }
        return search(document);
      });
      expect(hasDark, 'Fragment html element should not have dark class').toBe(false);
    });

    test('does not render the chrome navigation bar (#mp-chrome)', async ({ page }) => {
      const chrome = await queryInShadow(page, '#mp-chrome');
      expect(chrome, '#mp-chrome chrome bar must not appear inside the fragment (it escapes shadow DOM)').toBeNull();
    });

    test('shows LUM app card', async ({ page }) => {
      const text = await getFragmentText(page);
      expect(text).toContain('LUM');
    });

    test('shows Example app card', async ({ page }) => {
      const text = await getFragmentText(page);
      expect(text).toMatch(/Example/i);
    });

    test('app cards have correct absolute href links', async ({ page }) => {
      const links = await page.evaluate(() => {
        function search(root) {
          const anchors = [...root.querySelectorAll('a[href]')];
          if (anchors.length) return anchors.map(a => a.getAttribute('href'));
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) {
              const found = search(child.shadowRoot);
              if (found.length) return found;
            }
          }
          return [];
        }
        return search(document);
      });
      // All card links must be absolute paths starting with /knowledge-base/
      const cardLinks = links.filter(h => h && !h.startsWith('http') && !h.startsWith('#'));
      expect(cardLinks.length).toBeGreaterThan(0);
      for (const link of cardLinks) {
        expect(link, `Link "${link}" should start with /knowledge-base/`).toMatch(/^\/knowledge-base\//);
      }
    });
  });

  // ── Example module ────────────────────────────────────────────────────────

  test.describe('Example module', () => {
    test.beforeEach(async ({ page }) => {
      await gotoFragment(page, '/knowledge-base/example/');
    });

    test('loads the Example overview page', async ({ page }) => {
      const text = await getFragmentText(page);
      expect(text).toMatch(/Welcome|Overview|Example Docs/i);
    });

    test('has sidebar navigation links', async ({ page }) => {
      const nav = await queryInShadow(page, 'nav#sidebar');
      expect(nav, 'nav#sidebar not found inside fragment').not.toBeNull();
      expect(nav.text).toMatch(/Getting Started|Overview/i);
    });

    test('sidebar links are absolute paths', async ({ page }) => {
      const links = await page.evaluate(() => {
        function search(root) {
          const nav = root.querySelector('nav#sidebar');
          if (nav) return [...nav.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) {
              const found = search(child.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }
        return search(document);
      });
      expect(links, 'Sidebar links not found').not.toBeNull();
      for (const link of links) {
        expect(link, `Sidebar link "${link}" must be absolute`).toMatch(/^\/knowledge-base\//);
      }
    });

    test('navigating via sidebar does not cause full page reload', async ({ page }) => {
      // Record the current page navigation count before clicking
      let reloaded = false;
      page.on('load', () => { reloaded = true; });

      // Click "Getting Started" — should use fragment router (fetch + DOM swap)
      const clicked = await clickFragmentLink(page, 'a[href*="getting-started"]');
      expect(clicked, '"Getting Started" link not found in shadow DOM').toBe(true);

      // Wait for content to update
      await page.waitForTimeout(1500);

      // Check URL updated (fragment router calls history.pushState)
      const frame = await getFragmentFrame(page);
      if (frame) {
        expect(frame.url()).toContain('getting-started');
      }

      expect(reloaded, 'Full page reload occurred — fragment router is not working').toBe(false);
    });

    test('navigated page shows correct content', async ({ page }) => {
      await clickFragmentLink(page, 'a[href*="getting-started"]');
      await page.waitForTimeout(1500);

      const text = await getFragmentText(page);
      expect(text).toMatch(/Getting Started|Installation|Clone|npm/i);
    });

    test('back navigation (popstate) restores previous content', async ({ page }) => {
      // Go forward
      await clickFragmentLink(page, 'a[href*="getting-started"]');
      await page.waitForTimeout(1000);

      // Go back
      await page.goBack();
      await page.waitForTimeout(1000);

      const text = await getFragmentText(page);
      expect(text).toMatch(/Welcome|Overview|Example Docs/i);
    });

    test('has no fixed-position chrome bar escaping shadow DOM', async ({ page }) => {
      const chrome = await queryInShadow(page, '#mp-chrome');
      expect(chrome).toBeNull();
    });
  });

  // ── LUM module ────────────────────────────────────────────────────────────

  test.describe('LUM module', () => {
    test.beforeEach(async ({ page }) => {
      await gotoFragment(page, '/knowledge-base/lum/');
    });

    test('loads the LUM landing page', async ({ page }) => {
      const text = await getFragmentText(page);
      expect(text).toMatch(/LUM|Design|Data Workflow/i);
    });

    test('renders in headless mode', async ({ page }) => {
      const el = await queryInShadow(page, '[data-mp-headless]');
      expect(el).not.toBeNull();
    });

    test('is in light mode', async ({ page }) => {
      const hasDark = await page.evaluate(() => {
        function search(root) {
          const html = root.querySelector('html, wf-html');
          if (html) return html.classList.contains('dark');
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) {
              const r = search(child.shadowRoot);
              if (r !== null) return r;
            }
          }
          return null;
        }
        return search(document);
      });
      expect(hasDark).toBe(false);
    });

    test('has no fixed chrome bar', async ({ page }) => {
      expect(await queryInShadow(page, '#mp-chrome')).toBeNull();
    });

    test('internal links are absolute paths', async ({ page }) => {
      const links = await page.evaluate(() => {
        function search(root) {
          const anchors = [...root.querySelectorAll('a[href]')];
          if (anchors.length > 0) return anchors.map(a => a.getAttribute('href'));
          for (const child of root.querySelectorAll('*')) {
            if (child.shadowRoot) {
              const found = search(child.shadowRoot);
              if (found.length > 0) return found;
            }
          }
          return [];
        }
        return search(document);
      });
      const internal = links.filter(h => h && !h.startsWith('http') && !h.startsWith('mailto:') && !h.startsWith('#') && !h.startsWith('//'));
      for (const link of internal) {
        expect(link, `Internal link "${link}" must be absolute`).toMatch(/^\/knowledge-base\//);
      }
    });
  });

  // ── Cross-app navigation ──────────────────────────────────────────────────

  test.describe('Cross-app navigation', () => {
    test('clicking LUM card from landing navigates to LUM module', async ({ page }) => {
      await gotoFragment(page, '/knowledge-base/');

      await clickFragmentLink(page, 'a[href*="/lum/"]');
      await page.waitForTimeout(2000);

      const text = await getFragmentText(page);
      expect(text).toMatch(/LUM|Design|Data/i);
    });

    test('clicking Example card from landing navigates to Example module', async ({ page }) => {
      await gotoFragment(page, '/knowledge-base/');

      await clickFragmentLink(page, 'a[href*="/example/"]');
      await page.waitForTimeout(2000);

      const text = await getFragmentText(page);
      expect(text).toMatch(/Welcome|Overview|Example Docs/i);
    });
  });
});
