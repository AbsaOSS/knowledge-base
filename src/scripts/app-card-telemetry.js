// @ts-check
// (so `astro check` holds the event name to src/telemetry.schema.ts)
//
// Which apps people choose from the Library. The shell's page views already count
// every page; this tells a visit that started at a Library card from a deep link.
import { telemetry } from 'kb-telemetry';

// One listener on the document for the whole realm: the ClientRouter swaps the
// cards in and out with the Library page, and this module runs only once.
document.addEventListener('click', (event) => {
  // No `instanceof Element`: inside a web fragment the clicked node belongs to
  // the host document's realm, not this one.
  const target = /** @type {Element | null} */ (event.target);
  const card = target?.closest?.('a.kb-card[data-kb-app]');
  if (card) telemetry.bi.track('kb-app-card-clicked', { app: card.getAttribute('data-kb-app') });
});
