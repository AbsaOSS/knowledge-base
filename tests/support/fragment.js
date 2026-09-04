/**
 * tests/support/fragment.js
 *
 * Helpers for driving the knowledge-base web fragment from the host origin.
 *
 * The fragment renders as nested shadow roots:
 *   <web-fragment> ▸ shadowRoot ▸ <web-fragment-host> ▸ shadowRoot ▸ <wf-document>
 * Playwright CSS locators pierce OPEN shadow roots automatically, so for clicks
 * and visibility we use plain locators. For bulk text / attribute extraction we
 * walk the shadow tree manually inside page.evaluate (cheaper than many round
 * trips and lets us aggregate across every shadow root).
 */

const HOST_PREFIX = '/knowledge-base';

/** Navigate the host shell, optionally deep-linking a fragment route via ?wf=. */
export async function gotoFragment(page, fragmentRoute = '/knowledge-base/') {
  const url = fragmentRoute === '/knowledge-base/'
    ? '/'
    : `/?wf=${encodeURIComponent(fragmentRoute)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForFragmentReady(page);
  // Stamp a sentinel on the host window so later assertions can prove the HOST
  // page never did a full reload during fragment navigation.
  await page.evaluate(() => { window.__hostSentinel = 'alive'; });
}

/**
 * Resolves once the fragment's reframed BODY has rendered content.
 *
 * The reframed document is <wf-document><wf-html><wf-head/><wf-body/></wf-document>
 * inside web-fragment-host.shadowRoot. <wf-html> (with data-kb-headless) appears
 * before <wf-body> fills, so we must wait on wf-body having children — waiting on
 * data-kb-headless alone races the content in. (wf-body only exists in the reframed
 * shadow tree, never in the host document, so this can't match the host's <body>.)
 */
export async function waitForFragmentReady(page, { timeout = 20_000 } = {}) {
  await page.waitForFunction(() => {
    function search(root) {
      const body = root.querySelector('wf-body');
      if (body && body.childElementCount > 0) return true;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && search(el.shadowRoot)) return true;
      }
      return false;
    }
    return search(document);
  }, undefined, { timeout });
}

/** Waits until the fragment body text matches `re` (robust for post-nav swaps). */
export async function waitForFragmentText(page, re, { timeout = 15_000 } = {}) {
  await page.waitForFunction(({ source, flags }) => {
    const rx = new RegExp(source, flags);
    function search(root) {
      const body = root.querySelector('wf-body');
      if (body && rx.test(body.textContent || '')) return true;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && search(el.shadowRoot)) return true;
      }
      return false;
    }
    return search(document);
  }, { source: re.source, flags: re.flags }, { timeout });
}

/** True if the host window was NOT reloaded since gotoFragment stamped it. */
export async function hostStillAlive(page) {
  return page.evaluate(() => window.__hostSentinel === 'alive');
}

/** outerHTML + text of the first match anywhere in the shadow tree, or null. */
export async function queryInShadow(page, selector) {
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
    return el ? { html: el.outerHTML, text: el.textContent?.trim() ?? '' } : null;
  }, selector);
}

/** Collapsed text content of the fragment's reframed body (no head/style noise). */
export async function getFragmentText(page) {
  return page.evaluate(() => {
    function search(root) {
      const body = root.querySelector('wf-body');
      if (body) {
        const text = body.textContent?.replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot) {
          const r = search(child.shadowRoot);
          if (r) return r;
        }
      }
      return null;
    }
    return search(document) ?? '';
  });
}

/** All href attribute values found under `selector` (default: any anchor). */
export async function shadowHrefs(page, selector = 'a[href]') {
  return page.evaluate((sel) => {
    const out = [];
    function search(root) {
      for (const a of root.querySelectorAll(sel)) out.push(a.getAttribute('href'));
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot) search(child.shadowRoot);
      }
    }
    search(document);
    return out;
  }, selector);
}

/** Is the html/wf-html element inside the fragment in dark mode? */
export async function fragmentIsDark(page) {
  return page.evaluate(() => {
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
}

export { HOST_PREFIX };
