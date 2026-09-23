/**
 * src/scripts/embedded-transitions.js
 *
 * Makes Astro's <ClientRouter /> behave inside a web fragment. Base.astro loads
 * it on every page; standalone it does nothing.
 *
 * Embedded, the knowledge base's scripts run in reframed's hidden iframe, whose
 * `document` is patched so that documentElement/head/body resolve to the
 * wf-html/wf-head/wf-body elements living in the host document's shadow tree.
 * Two things go wrong for the ClientRouter there (and a third, for a pierced
 * first page, is dropPortalSnapshots() below):
 *
 *  1. document.startViewTransition() animates the hidden iframe, which is never
 *     painted, so a navigation swaps with no crossfade. The gateway keeps the
 *     fragment and the host on one origin, so the host document's
 *     startViewTransition() can run the transition instead — the one the
 *     visitor actually sees. (If the host runs its own view transition at the
 *     same time, the browser skips ours; the DOM update still happens.)
 *
 *  2. The page the router fetches comes back from reframed's patched DOMParser
 *     wrapped as body > wf-html > wf-head + wf-body. Astro's default swap
 *     replaces the current wf-body with that parsed <body>, so every navigation
 *     nests one more wf-html inside the previous one and leaks its head: one
 *     extra copy of every stylesheet per page visited. The swap below addresses
 *     the wf-* elements on both sides, so the tree stays one level deep and the
 *     head is diffed in place.
 */
import { swapFunctions } from 'astro:transitions/client';
import { LAYER_ORDER } from '../utils/css-layers.js';

const PERSIST = 'data-astro-transition-persist';

function hostDocument() {
  try {
    if (window.top === window) return null;
    const doc = window.top.document; // throws when the host is cross-origin
    return typeof doc.startViewTransition === 'function' ? doc : null;
  } catch {
    return null;
  }
}

const host = hostDocument();
if (host) {
  document.startViewTransition = (update) => host.startViewTransition(update);
}

/** The reframed element, or what Astro would use when the document is not reframed. */
const pick = (doc, tag, fallback) => doc.querySelector(tag) ?? fallback;

/**
 * The node in `newHead` that `el` can stand in for, or null. A stylesheet or
 * script kept in place is neither re-fetched nor re-run; the same rules Astro's
 * own head swap applies, plus inline <style> with identical text.
 */
function counterpart(el, newHead) {
  const id = el.getAttribute(PERSIST);
  if (id) return newHead.querySelector(`[${PERSIST}="${CSS.escape(id)}"]`);
  const tag = el.localName;
  const same = (attr) => (n) => n.getAttribute(attr) === el.getAttribute(attr);
  if (tag === 'link' && el.getAttribute('href')) {
    return [...newHead.querySelectorAll('link[href]')].find((n) => same('href')(n) && same('rel')(n)) ?? null;
  }
  if (tag === 'script' && el.getAttribute('src')) {
    return [...newHead.querySelectorAll('script[src]')].find(same('src')) ?? null;
  }
  if (tag === 'style' || tag === 'script') {
    return [...newHead.querySelectorAll(`${tag}:not([src])`)].find((n) => n.textContent === el.textContent) ?? null;
  }
  return null;
}

function swapRootAttributes(root, newRoot) {
  for (const { name } of [...root.attributes]) {
    if (!name.startsWith('data-astro-transition')) root.removeAttribute(name);
  }
  for (const { name, value } of [...newRoot.attributes]) root.setAttribute(name, value);
}

function swapHead(head, newHead) {
  const reuse = new Map();
  for (const old of [...head.children]) {
    const next = counterpart(old, newHead);
    if (next && !reuse.has(next)) reuse.set(next, old);
  }
  // A reused node is never moved, not even with moveBefore(). On a pierced
  // page the sub-app's <link rel="stylesheet"> has already been moved once —
  // reframed portals the server-rendered host into the <web-fragment>'s
  // shadow root with moveBefore() — and moving it a second time makes
  // Chromium drop the sheet from the shadow root's applied stylesheets: the
  // element keeps its .sheet, styleSheets no longer lists it, and the page
  // renders without its CSS until a reload. (Removing and re-appending would
  // re-fetch and re-apply it, at the price of a flash.) So reused nodes are
  // anchors, and each new node is inserted ahead of the next anchor. The
  // anchors keep the old page's relative order among themselves, which is
  // fine: every stylesheet declares the cascade layer order itself, so
  // nothing depends on which one the browser parses first.
  const kept = new Set();
  let anchor = head.firstChild;
  for (const next of [...newHead.children]) {
    const old = reuse.get(next);
    if (old) {
      kept.add(old);
      anchor = old.nextSibling;
    } else {
      head.insertBefore(next, anchor);
      kept.add(next);
    }
  }
  for (const old of [...head.children]) {
    if (!kept.has(old)) old.remove();
  }
}

/**
 * Removes the copies of the sub-app stylesheets that reframed left adopted on
 * the fragment's shadow root.
 *
 * When reframed portals a server-rendered (pierced) fragment it copies every
 * linked sheet's rules into a constructed stylesheet and adopts it, to cover
 * the moment the <link> is re-inserted. It deletes those copies once it sees
 * the stylesheet fetched again — but on the moveBefore() path the <link> is
 * moved atomically and never re-fetched, so the copies stay adopted for the
 * life of the fragment: the first app's CSS then applies to every page the
 * visitor navigates to, the catalog and other apps included. Before the first
 * swap the <link> each copy stands in for is still applied, so dropping the
 * copies there changes nothing on the current page.
 *
 * Only the knowledge base's own copies are dropped: every sub-app stylesheet
 * the build writes opens with the cascade-layer order statement (see
 * src/utils/css-layers.js), and a copy keeps that first rule. document here is
 * reframed's, whose adoptedStyleSheets is the fragment shadow root's.
 */
function dropPortalSnapshots() {
  const adopted = document.adoptedStyleSheets;
  if (!adopted || adopted.length === 0) return;
  const isSnapshot = (sheet) => {
    try {
      return !sheet.href && sheet.cssRules[0]?.cssText === LAYER_ORDER;
    } catch {
      return false;
    }
  };
  if (adopted.some(isSnapshot)) document.adoptedStyleSheets = adopted.filter((s) => !isSnapshot(s));
}

document.addEventListener('astro:before-swap', (event) => {
  dropPortalSnapshots();
  const newDoc = event.newDocument;
  const current = {
    root: document.querySelector('wf-html'),
    head: document.querySelector('wf-head'),
    body: document.querySelector('wf-body'),
  };
  // Standalone there are no wf-* elements. Embedded, the very first page is
  // rendered by reframed as plain html/head/body; Astro's default swap turns it
  // into the wf-* tree, and nothing has leaked yet at that point.
  if (!current.root || !current.head || !current.body) return;

  const next = {
    root: pick(newDoc, 'wf-html', newDoc.documentElement),
    head: pick(newDoc, 'wf-head', newDoc.head),
    body: pick(newDoc, 'wf-body', newDoc.body),
  };

  event.swap = () => {
    swapFunctions.deselectScripts(newDoc);
    swapRootAttributes(current.root, next.root);
    swapHead(current.head, next.head);
    const restoreFocus = swapFunctions.saveFocus();
    swapFunctions.swapBodyElement(next.body, current.body);
    restoreFocus();
  };
});
