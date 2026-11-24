/**
 * Shell adapter used when the deployment supplies none: no host shell is ever
 * detected, so telemetry stays inert and no readiness is reported.
 *
 * A deployment adapter exports the same function. It returns `null` outside
 * its shell, or `{ channelName?, ready(), failed(), dispose() }` inside it.
 * @returns {null}
 */
export function connectShell() {
  return null;
}
