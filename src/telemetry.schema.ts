/**
 * The knowledge base's telemetry vocabulary.
 *
 * Scenario, step and business event names are metric dimensions: a typo does
 * not fail, it starts a second series beside the one a dashboard reads. They
 * are declared once here and used only through the constants below, which
 * `astro check` holds to the declarations.
 */
import type { UwtBIEventName, UwtScenarioName, UwtStepName } from '@absaoss-cps/ui-watchtower';

declare module '@absaoss-cps/ui-watchtower' {
  interface UwtScenarioNames {
    /** An in-app navigation, from the router's preparation to the new page being active. */
    'kb-route-navigate': true;
  }

  // Steps and aggregates share this registry.
  interface UwtScenarioSteps {
    /** Loading, swapping and activating the next page. */
    activate: true;
  }

  interface UwtBIEventNames {
    /** The library catalog became the active page. */
    'kb-catalog-viewed': true;
    /** A documentation page became the active page. */
    'kb-document-opened': true;
  }
}

export const SCENARIO_ROUTE_NAVIGATE = 'kb-route-navigate' satisfies UwtScenarioName;
export const STEP_ACTIVATE = 'activate' satisfies UwtStepName;
export const BI_CATALOG_VIEWED = 'kb-catalog-viewed' satisfies UwtBIEventName;
export const BI_DOCUMENT_OPENED = 'kb-document-opened' satisfies UwtBIEventName;
