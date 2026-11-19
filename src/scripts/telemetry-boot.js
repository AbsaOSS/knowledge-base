// Bundled as `kb-telemetry` (astro.config.mjs); import `telemetry` from there,
// not from this file, so a build without telemetry can swap in ./telemetry-off.js.
// `kb-shell-adapter` resolves to the deployment's shell adapter, or ./no-shell.js.
import { connectShell } from 'kb-shell-adapter';
import { startTelemetry } from './telemetry.js';
// Instrumentation (scripts that only measure) is loaded here, not from
// Base.astro, so a build without telemetry carries none of it. Each one imports
// `telemetry` back from `kb-telemetry`, this module, and reads it only inside
// its event handlers, which run after this module has finished.
import './app-card-telemetry.js';
import './page-open-telemetry.js';

const controller = startTelemetry(window, document, connectShell);
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());

/** The page's shared Watchtower engine; inert outside a configured shell. */
export const telemetry = controller.telemetry;
