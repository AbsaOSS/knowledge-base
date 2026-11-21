// src/scripts/masthead-nav.js
//
// Progressive enhancement for the masthead bar's section dropdowns (<details>):
// Escape closes one and returns focus to its toggle, leaving it by keyboard or
// clicking elsewhere closes it, and a panel that would run off the right edge
// of the viewport opens right-aligned instead. Without this module the
// dropdowns still open, close and navigate — the compact menu is a popover and
// needs none of it.
//
// Listeners go on the masthead and on the document it is displayed in, never
// on `document`: inside a web fragment this module runs in reframed's iframe
// while the masthead lives in the host's shadow tree, so `document` is the
// iframe's. The masthead is replaced on every ClientRouter swap, so it is
// wired again on each astro:page-load.

const OPEN = 'details.kb-nav-dropdown[open]';
const wiredDocs = new WeakSet();
/** The window the masthead is actually displayed in; see wireOutsideClicks. */
let view = window;

function close(details, refocus) {
  details.open = false;
  if (refocus) details.querySelector('summary')?.focus();
}

/** Right-aligns a panel that would otherwise overflow the viewport. */
function place(details) {
  const panel = details.querySelector('.kb-nav-panel');
  if (!panel) return;
  panel.classList.remove('kb-nav-panel--end');
  if (!details.open) return;
  // The reader's viewport, not reframed's hidden iframe (see wireOutsideClicks).
  const width = view.document.documentElement.clientWidth;
  if (panel.getBoundingClientRect().right > width) panel.classList.add('kb-nav-panel--end');
}

/**
 * Outside clicks, including on an embedding host's own chrome. Inside a web
 * fragment reframed reports its iframe's document as the masthead's
 * ownerDocument and root node, so neither names the page the reader clicks
 * on. The window a click on the masthead really fired in does: the listener
 * goes on that window's document, and composedPath() sees through the
 * fragment's open shadow roots. The document outlives the masthead, so it is
 * wired once and looks the current masthead up on every click.
 */
function wireOutsideClicks(doc) {
  if (!doc || wiredDocs.has(doc)) return;
  wiredDocs.add(doc);
  doc.addEventListener('click', (event) => {
    const masthead = document.getElementById('kb-masthead');
    if (!masthead) return;
    const path = event.composedPath();
    for (const details of masthead.querySelectorAll(OPEN)) {
      if (!path.includes(details)) close(details, false);
    }
  });
}

function wire() {
  const masthead = document.getElementById('kb-masthead');
  if (!masthead || masthead.dataset.kbNavWired) return;
  masthead.dataset.kbNavWired = 'true';

  masthead.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const details = event.target.closest?.(OPEN);
    if (!details) return;
    event.preventDefault();
    close(details, true);
  });

  // Tabbing out only: a null relatedTarget is also what Safari reports when a
  // click lands on a link it does not focus, and closing then would hide the
  // link before the click reaches it. Clicks are handled below.
  masthead.addEventListener('focusout', (event) => {
    const details = event.target.closest?.(OPEN);
    if (details && event.relatedTarget && !details.contains(event.relatedTarget)) close(details, false);
  });

  // `toggle` does not bubble; capture still reaches the masthead.
  masthead.addEventListener('toggle', (event) => {
    if (event.target.matches?.('details.kb-nav-dropdown')) place(event.target);
  }, true);

  // A dropdown only opens through a click on its summary — Enter and Space
  // included — so that click is the first chance to learn the real window.
  masthead.addEventListener('click', (event) => {
    if (!event.view) return;
    view = event.view;
    wireOutsideClicks(view.document);
  });
}

wire();
document.addEventListener('astro:page-load', wire);
