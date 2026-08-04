// src/utils/single-page.js
//
// Shared helpers for the "single-page" onboarding type (issue #35).
//
// A single-page entry in apps.json points at ONE release artifact that contains
// MANY docs — the repo publishes them with actions/publish-single-page-docs. The registry
// entry therefore carries no per-doc metadata:
//
//   { "repo": "org/repo", "type": "single-page", "version": "latest" }
//
// Everything the catalog needs lives in the artifact's bundle.json manifest, so
// onboarding a new doc never touches this repository. The build "expands" one
// registry entry into N marketplace apps, one per doc.
//
// Imported by both scripts/fetch-apps.js (GitHub path) and scripts/build-vite.js
// (prebuilt/local path) so the two never drift, and by src/utils/apps.js so Astro
// sees the expanded registry.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SINGLE_PAGE_TYPE = 'single-page';
/** Manifest at the root of a single-page artifact. */
export const BUNDLE_MANIFEST = 'bundle.json';
/** Where the build records what each bundle expanded into, for Astro to read. */
export const EXPANSION_FILE = join('apps', '.single-page.json');

/** Icon set — kept in sync with contract/schema.json. */
const ICONS = [
  'book-open', 'cube', 'chip', 'chart-bar', 'shield',
  'cog', 'terminal', 'globe', 'layers', 'lightning-bolt',
  'document', 'collection', 'puzzle', 'database',
];
const DEFAULT_ICON = 'book-open';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSinglePage(app) {
  return app?.type === SINGLE_PAGE_TYPE;
}

/**
 * Stable identity of a single-page registry entry.
 *
 * Used to key the expansion map, so Astro can splice each bundle's docs back
 * into the registry at exactly the position its entry occupies.
 */
export function bundleKey(app) {
  const key = app.repo ?? app.prebuilt ?? app.localPath;
  if (!key) {
    throw new Error(
      `apps.json: a "${SINGLE_PAGE_TYPE}" entry needs one of "repo", "prebuilt" or "localPath"`,
    );
  }
  return key;
}

/** Filesystem-safe form of a bundle key, for staging directory names. */
export function bundleDirName(key) {
  return key.replace(/[^a-z0-9._-]+/gi, '__');
}

/**
 * Locates the bundle root inside an extracted artifact.
 *
 * Bundles are packed with bundle.json at the archive root, but a repo may also
 * publish one wrapped in dist/ — accept both rather than fail on a detail the
 * onboarding repo cannot see.
 */
export function findBundleRoot(stageDir) {
  for (const candidate of [stageDir, join(stageDir, 'dist')]) {
    if (existsSync(join(candidate, BUNDLE_MANIFEST))) return candidate;
  }
  return null;
}

/**
 * Reads and validates a bundle manifest.
 *
 * @param {string} bundleRoot - directory containing bundle.json
 * @param {string} source     - human-readable origin, used in error messages
 */
export function readBundleManifest(bundleRoot, source) {
  const file = join(bundleRoot, BUNDLE_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${source}: ${BUNDLE_MANIFEST} is not valid JSON — ${err.message}`);
  }

  if (manifest.marketplaceVersion !== '1') {
    throw new Error(
      `${source}: ${BUNDLE_MANIFEST} has marketplaceVersion ` +
      `${JSON.stringify(manifest.marketplaceVersion)} — this knowledge base understands "1".`,
    );
  }
  if (manifest.type !== SINGLE_PAGE_TYPE) {
    throw new Error(
      `${source}: ${BUNDLE_MANIFEST} declares type ${JSON.stringify(manifest.type)}, ` +
      `expected "${SINGLE_PAGE_TYPE}".`,
    );
  }
  if (!Array.isArray(manifest.docs) || manifest.docs.length === 0) {
    throw new Error(`${source}: ${BUNDLE_MANIFEST} lists no docs.`);
  }
  return manifest;
}

/**
 * Turns a bundle manifest into marketplace app entries — one per doc.
 *
 * Each returned entry looks like a normal apps.json app (slug/name/description/
 * icon/tags) so every downstream consumer — catalog cards, masthead, routing —
 * needs no knowledge of bundles. `docDir` is the source directory to copy into
 * apps/{slug}/ and is stripped before the entry is persisted.
 *
 * @param {object} app        - the apps.json entry the bundle came from
 * @param {object} manifest   - output of readBundleManifest
 * @param {string} bundleRoot - directory the manifest was read from
 */
export function expandBundle(app, manifest, bundleRoot) {
  const source = bundleKey(app);
  const seen = new Set();
  const docs = [];

  for (const [i, doc] of manifest.docs.entries()) {
    const where = `${source}: ${BUNDLE_MANIFEST} docs[${i}]`;

    if (typeof doc?.slug !== 'string' || !SLUG_RE.test(doc.slug)) {
      throw new Error(`${where} has an invalid slug ${JSON.stringify(doc?.slug)} — expected lowercase kebab-case.`);
    }
    if (seen.has(doc.slug)) {
      throw new Error(`${where} repeats slug "${doc.slug}" — slugs must be unique within a bundle.`);
    }
    seen.add(doc.slug);

    if (typeof doc.title !== 'string' || doc.title.trim() === '') {
      throw new Error(`${where} ("${doc.slug}") is missing a title.`);
    }
    if (typeof doc.description !== 'string' || doc.description.trim() === '') {
      throw new Error(`${where} ("${doc.slug}") is missing a description.`);
    }

    const entryPoint = doc.entryPoint ?? 'index.html';
    const docDir = join(bundleRoot, doc.slug);
    if (!existsSync(join(docDir, entryPoint))) {
      throw new Error(
        `${where} ("${doc.slug}") declares entryPoint "${entryPoint}" but ` +
        `${doc.slug}/${entryPoint} is not in the artifact.`,
      );
    }

    docs.push({
      slug:        doc.slug,
      name:        doc.title.trim(),
      description: doc.description.trim(),
      icon:        ICONS.includes(doc.icon) ? doc.icon : DEFAULT_ICON,
      tags:        Array.isArray(doc.tags) ? doc.tags.slice(0, 5) : [],
      type:        SINGLE_PAGE_TYPE,
      entryPoint,
      docDir,
    });
  }

  return docs;
}

/** Drops build-only fields so the expansion map stays a plain registry fragment. */
export function toRegistryEntry({ docDir, ...entry }) {
  return entry;
}

// ── Expansion map ─────────────────────────────────────────────────────────────
// The committed apps.json cannot list the expanded docs (they are discovered from
// the artifact), and rewriting the registry in place would make a build mutate a
// checked-in file. Instead the build drops a map next to the artifacts and Astro
// splices it back in at read time.

export function readExpansionMap(cwd) {
  const file = join(cwd, EXPANSION_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function writeExpansionMap(cwd, map) {
  const file = join(cwd, EXPANSION_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
}

/**
 * Replaces every single-page registry entry with the docs it expanded into.
 *
 * Non-single-page entries pass through untouched and always come straight from
 * apps.json, so editing the registry never goes stale against the map.
 *
 * @param {Array}  registry - raw apps.json contents
 * @param {object} map      - output of readExpansionMap
 * @param {(msg: string) => void} [warn]
 */
export function resolveRegistry(registry, map, warn = () => {}) {
  const resolved = [];

  for (const app of registry) {
    if (!isSinglePage(app)) { resolved.push(app); continue; }

    const key = bundleKey(app);
    const docs = map[key];
    if (!docs || docs.length === 0) {
      // `optional` entries are expected to be missing whenever their artifact is
      // not checked out (see build-vite.js) — that is not worth a warning.
      if (!app.optional) {
        warn(`${key}: single-page bundle has not been prepared yet — run a build to populate ${EXPANSION_FILE}`);
      }
      continue;
    }
    resolved.push(...docs);
  }

  assertUniqueSlugs(resolved);
  return resolved;
}

/**
 * Guards against two apps claiming the same URL prefix.
 *
 * Single-page bundles are the reason this has to be enforced globally: a repo
 * chooses its own slugs without seeing the rest of the registry, so a collision
 * with an existing app would otherwise silently overwrite apps/{slug}/.
 */
export function assertUniqueSlugs(apps) {
  const seen = new Map();
  for (const app of apps) {
    if (!app.slug) continue;
    if (seen.has(app.slug)) {
      throw new Error(
        `Duplicate app slug "${app.slug}": claimed by both ${describe(seen.get(app.slug))} and ` +
        `${describe(app)}. Slugs are URL prefixes and must be unique across the whole registry — ` +
        `rename one of them (for a single-page bundle, change the slug in the publishing repo).`,
      );
    }
    seen.set(app.slug, app);
  }
  return apps;
}

function describe(app) {
  if (isSinglePage(app)) return `single-page doc "${app.name ?? app.slug}"`;
  return `apps.json entry "${app.name ?? app.slug}"`;
}
