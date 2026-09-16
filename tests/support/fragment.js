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

// ── Host router + bound mode ─────────────────────────────────────────────────

/**
 * Navigate the host in BOUND mode: the shell is served for the fragment route
 * itself (no `?wf=`), the `<web-fragment>` carries no `src`, and the host
 * router (tests/host/host-router.js) owns the address bar together with the
 * fragment's ClientRouter. `hostRoutes: 'narrow'` selects the misconfigured
 * host route table.
 */
export async function gotoBoundFragment(page, fragmentRoute = '/knowledge-base/', { hostRoutes = 'wide' } = {}) {
  const url = hostRoutes === 'wide' ? fragmentRoute : `${fragmentRoute}?hostRoutes=${hostRoutes}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForFragmentReady(page);
  await page.evaluate(() => { window.__hostSentinel = 'alive'; });
}

/** The host router's navigation log (see tests/host/host-router.js). */
export async function hostRouterLog(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__hostRouter.log)));
}

/** Drive the host router imperatively, as Angular's Router.navigateByUrl would. */
export async function hostNavigate(page, url) {
  await page.evaluate((u) => window.__hostRouter.navigate(u), url);
}

/**
 * The hidden reframed iframe (`wf:knowledge-base`) whose window runs the
 * fragment's scripts — Astro's ClientRouter included. Playwright sees it as an
 * ordinary frame, so its JS state can be inspected directly. Null when no
 * fragment is mounted.
 */
export function fragmentFrame(page) {
  return page.frame({ name: 'wf:knowledge-base' });
}

/**
 * Stamp a sentinel on the fragment's window and start counting ClientRouter
 * swaps. Both disappear if the reframed iframe reloads or is recreated, which
 * is what "the fragment survived the navigation" means.
 */
export async function armFragmentProbe(page) {
  const frame = fragmentFrame(page);
  if (!frame) throw new Error('no wf:knowledge-base frame — is the fragment mounted?');
  await frame.evaluate(() => {
    window.__kbSentinel = 'alive';
    window.__kbSwaps = 0;
    document.addEventListener('astro:after-swap', () => { window.__kbSwaps += 1; });
  });
  // Count view transitions started on the HOST document — the ones a visitor
  // can see. The counter survives fragment remounts; only the wrapper is one-shot.
  await page.evaluate(() => {
    window.__hostViewTransitions = 0;
    if (window.__hostVtWrapped || typeof document.startViewTransition !== 'function') return;
    window.__hostVtWrapped = true;
    const original = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      window.__hostViewTransitions += 1;
      return original(update);
    };
  });
}

/**
 * { alive, swaps, hostViewTransitions } from the probe. `alive` is false and
 * `swaps` -1 when the frame is gone or was recreated since the probe was armed.
 */
export async function fragmentProbe(page) {
  const hostViewTransitions = await page.evaluate(() => window.__hostViewTransitions ?? -1);
  const frame = fragmentFrame(page);
  if (!frame) return { alive: false, swaps: -1, hostViewTransitions };
  const inFrame = await frame.evaluate(() => ({
    alive: window.__kbSentinel === 'alive',
    swaps: typeof window.__kbSwaps === 'number' ? window.__kbSwaps : -1,
  }));
  return { ...inFrame, hostViewTransitions };
}

/** Text of the current sub-app page heading (`#content h1`), or null. */
export async function fragmentH1(page) {
  const h1 = await queryInShadow(page, '#content h1');
  return h1 ? h1.text.replace(/\s+/g, ' ').trim() : null;
}

/** Number of elements matching `selector` across the document and every open shadow root. */
export async function countInShadow(page, selector) {
  return page.evaluate((sel) => {
    let n = 0;
    function search(root) {
      n += root.querySelectorAll(sel).length;
      for (const child of root.querySelectorAll('*')) {
        if (child.shadowRoot) search(child.shadowRoot);
      }
    }
    search(document);
    return n;
  }, selector);
}

export { HOST_PREFIX };
