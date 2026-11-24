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

export {};
