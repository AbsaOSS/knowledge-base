/**
 * src/scripts/embedded-transitions.js
 *
 * Makes Astro's <ClientRouter /> behave inside a web fragment. Base.astro loads
 * it on every page; standalone it does nothing.
 *
 * Embedded, the knowledge base's scripts run in reframed's hidden iframe, whose
 * `document` is patched so that documentElement/head/body resolve to the
 * wf-html/wf-head/wf-body elements living in the host document's shadow tree.
 * Two things go wrong for the ClientRouter there:
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
  // Walk the new head in order, so the rebuilt head keeps the new page's
  // order: the layout's `@layer base;` has to stay ahead of the sub-app's
  // stylesheets after every navigation, not only on first load.
  const canMove = typeof head.moveBefore === 'function';
  const placed = new Set();
  for (const next of [...newHead.children]) {
    const node = reuse.get(next) ?? next;
    if (node === next || !canMove) head.append(node);
    else head.moveBefore(node, null); // keeps a stylesheet's state; append would re-apply it
    placed.add(node);
  }
  for (const old of [...head.children]) {
    if (!placed.has(old)) old.remove();
  }
}

document.addEventListener('astro:before-swap', (event) => {
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
