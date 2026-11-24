// Build-time aliases resolved in astro.config.mjs.
declare module 'kb-telemetry' {
  /** The page's telemetry API: the UI Watchtower engine, or an inert stub when telemetry is not enabled. */
  export const telemetry: import('@absaoss-cps/ui-watchtower').UwtTelemetry;
}
