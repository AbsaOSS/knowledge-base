// src/utils/config.js
//
// The two build-wide decisions — where the site is mounted, and whether this
// build is a web fragment — in one place, because both used to be spelled out
// independently in three or four files and the copies disagreed.

/**
 * The URL prefix everything is served under.
 *
 * **Not configurable, deliberately.** The build used to advertise a
 * `--path-prefix=` flag and an environment variable that nothing in the Astro
 * build ever read, so `--path-prefix=docs` produced a `dist/` that still said
 * `knowledge-base` everywhere and only the closing build summary agreed with the
 * flag (#46). Making it real means templating `nginx.conf`, the `/__wf/` rewrite
 * and the fragment gateway's route patterns too — all of which bake this string
 * in — so the honest fix was to delete the flag and keep one constant.
 *
 * Changing the prefix is a deployment change, not a build option: this constant,
 * `nginx.conf`, `tests/fragment-server.mjs` and the gateway config must move
 * together.
 */
export const PATH_PREFIX = 'knowledge-base';

/** The same thing as an absolute path — Astro's `base`, and every link root. */
export const BASE_PATH = `/${PATH_PREFIX}`;

/**
 * Whether this build produces web-fragment (headless) output.
 *
 * **Unset means standalone.** `scripts/build-vite.js` always exports an explicit
 * `'true'`/`'false'`, so the default only applies when `astro build`/`astro dev`
 * is run directly — and there, "I did not ask for a fragment" is the answer that
 * matches the flag's name. Base.astro used to read `!== 'false'` (unset ⇒
 * headless) while the orchestrator computed the opposite; nothing caught it
 * because the orchestrator never leaves the variable unset (#52).
 *
 * A per-app `"headless"` in apps.json overrides this in either direction; the
 * override is resolved in src/utils/apps.js and passed down as a prop.
 */
export function isHeadlessBuild(env = process.env) {
  return env.KB_HEADLESS === 'true';
}

/**
 * The registry file this build reads, relative to the project root.
 *
 * `apps.json` here is the CI and preview registry: the vendored fixture plus the
 * optional sibling example. A real deployment owns its own registry in its own
 * repository and points this at it, so that this repo is a build tool rather
 * than a list of somebody's documentation.
 *
 * Read at module load: both the orchestrator and Astro's getStaticPaths need the
 * same answer within one build, and an environment variable that changed
 * halfway would silently produce a dist/ assembled from two registries.
 */
export const REGISTRY_FILE = process.env.KB_REGISTRY?.trim() || 'apps.json';
