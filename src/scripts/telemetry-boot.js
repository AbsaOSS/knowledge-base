// Bundled as `kb-telemetry` (astro.config.mjs); import `telemetry` from there,
// not from this file, so a build without telemetry can swap in ./telemetry-off.js.
// `kb-shell-adapter` resolves to the deployment's shell adapter, or ./no-shell.js.
import { connectShell } from 'kb-shell-adapter';
import { startTelemetry } from './telemetry.js';

const controller = startTelemetry(window, document, connectShell);
if (import.meta.hot) import.meta.hot.dispose(() => controller.dispose());

/** The page's shared Watchtower engine; inert outside a configured shell. */
export const telemetry = controller.telemetry;
