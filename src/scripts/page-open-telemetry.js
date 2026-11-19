// @ts-check
// (so `astro check` holds the scenario and step names to src/telemetry.schema.ts)
//
// How long opening a page inside the knowledge base takes, and whether it
// works: from the click to the new page being active, per app. The first page
// of a visit is the host shell's to measure; this covers every page after it.
import { telemetry } from 'kb-telemetry';
import { BASE_PATH } from '../utils/config.js';

/** @typedef {import('astro:transitions/client').TransitionBeforePreparationEvent} PreparationEvent */
/** @typedef {import('astro:transitions/client').TransitionBeforeSwapEvent} SwapEvent */

/** @type {{ scenario: import('@absaoss-cps/ui-watchtower').UwtScenario, signal: AbortSignal, swapped: boolean } | undefined} */
let opening;

document.addEventListener('astro:before-preparation', (event) => {
  const preparation = /** @type {PreparationEvent} */ (event);
  const library = preparation.to.pathname.replace(/\/$/, '') === BASE_PATH;
  const scenario = telemetry.scenarios.start({
    name: 'kb-page-open',
    route: library ? `${BASE_PATH}/` : `${BASE_PATH}/:app/*`,
  });
  scenario.step('fetch');
  opening = { scenario, signal: preparation.signal, swapped: false };
  // Astro aborts a navigation when a newer one starts.
  preparation.signal.addEventListener('abort', () => scenario.cancel({ reason: 'superseded' }), { once: true });
  const loader = preparation.loader;
  preparation.loader = async () => {
    await loader();
    // Astro could not use the answer (not HTML, a page without the ClientRouter
    // such as a 404, or a failed fetch) and hands the link to the browser.
    if (preparation.defaultPrevented && !preparation.signal.aborted) {
      scenario.incomplete({ reason: 'browser-fallback' });
    }
  };
});

document.addEventListener('astro:before-swap', (event) => {
  if (opening?.signal !== /** @type {SwapEvent} */ (event).signal) return;
  opening.swapped = true;
  opening.scenario.step('render');
});

document.addEventListener('astro:page-load', () => {
  if (!opening?.swapped) return;
  const { scenario } = opening;
  opening = undefined;
  const app = document.querySelector('#kb-masthead')?.getAttribute('data-kb-app');
  scenario.complete(app ? { metadata: { app } } : undefined);
});
