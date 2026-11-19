/**
 * The knowledge base's telemetry vocabulary.
 *
 * Scenario, step and business event names are metric dimensions, declared
 * once here rather than as free text at each call site. Once a registry has
 * an entry, a name not listed in it is a compile error.
 *
 * Names are kebab-case. Scenario, BI event and logger names start with the
 * prefix `kb`. Step names have no prefix.
 *
 * src/scripts/telemetry.js, where the engine is created, keeps a side-effect
 * import of this file, so it can never become unreferenced.
 */
// Loads the module being augmented, even where nothing else in the program imports it.
import type {} from '@absaoss-cps/ui-watchtower';

declare module '@absaoss-cps/ui-watchtower' {
  interface UwtScenarioNames {
    // Only with route-navigation tracking (setup Step 6, option 1):
    // /** A router navigation, from click to activated route, under the final route template. */
    // 'kb-route-navigate': true;

    // One entry per confirmed journey, <prefix>-<thing>-<action>, with a line saying what it measures:
    // /** Loading the customer list, from request to first render. */
    // 'kb-customers-load': true;
  }

  // Add once the first journey with steps is confirmed (no prefix: <action> or
  // <thing>-<action>; steps and aggregates share this registry):
  // interface UwtScenarioSteps {
  //   /** Fetching data from the API. */
  //   fetch: true;
  // }

  // Add once the first business event is confirmed (<prefix>-<thing>-<past-tense verb>):
  // interface UwtBIEventNames {
  //   /** The user exported the current result set. */
  //   'kb-export-clicked': true;
  // }

  // Only when the app has a log backend (a real log provider, not the no-op one):
  // interface UwtLoggerNames {
  //   /** Application lifecycle and routing (<prefix>-<area>). */
  //   'kb-lifecycle': true;
  // }
}

export {};
