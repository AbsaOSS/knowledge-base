// src/utils/theme.js
//
// Recognises a sub-app's own dark-mode bootstrap. Dependency-free on purpose:
// the build strips what this matches (transform.js, hoist-inline-scripts.js),
// and the publishing actions' checker (actions/lib/check.js) reports it to the
// repo that ships it — one definition for both, so they cannot disagree about
// what counts as a theme bootstrap.

/**
 * True when a script body is a sub-app's own dark-mode bootstrap.
 *
 * The strip has to happen in two places: in transform.js for the `astro dev`
 * path, and in scripts/hoist-inline-scripts.js for the build, which turns
 * inline scripts into files before transform.js ever sees the document — a
 * hoisted bootstrap would otherwise sail past the strip and re-add `dark` at
 * runtime, which is exactly the leak the light-only rule exists to prevent.
 */
export function isThemeBootstrap(code) {
  return /\blocalStorage\b/.test(code) &&
         /\bclassList\b/.test(code) &&
         /\bdark\b|\btheme\b/i.test(code);
}
