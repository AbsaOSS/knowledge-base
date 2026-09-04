// src/utils/registry.js
//
// The registry and the artifact manifest, in one place.
//
// apps.json says *where* an artifact comes from. kb-docs.json, inside the
// artifact, says *what* it is. Those two sentences are the whole design:
//
//   apps.json     [{ "repo": "org/repo", "version": "latest" }]
//   kb-docs.json  { "kbVersion": "1", "apps": [ { slug, name, description, … } ] }
//
// Every source — a GitHub release, a prebuilt tarball, a local checkout — yields
// the same thing: a directory holding kb-docs.json plus one subdirectory per
// app. So there is one reader, one validator and one install path, and adding,
// renaming or removing a doc never touches this repository.
//
// Imported by scripts/build-vite.js (which installs), scripts/fetch-apps.js
// (which downloads) and src/utils/apps.js (so Astro resolves the same registry
// the build did).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Manifest at the root of a kb-docs.tar.gz artifact. See contract/ARTIFACT.md. */
export const MANIFEST = 'kb-docs.json';
/** The release asset a docs repo publishes. */
export const ARTIFACT_NAME = 'kb-docs.tar.gz';
/** The contract version this knowledge base understands. */
export const KB_VERSION = '1';
/** Where the build records what each artifact expanded into, for Astro to read. */
export const EXPANSION_FILE = join('apps', '.registry.json');

/** Icon set — kept in sync with contract/kb-docs.schema.json. */
const ICONS = [
  'book-open', 'cube', 'chip', 'chart-bar', 'shield',
  'cog', 'terminal', 'globe', 'layers', 'lightning-bolt',
  'document', 'collection', 'puzzle', 'database',
];
const DEFAULT_ICON = 'book-open';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Artifact size budget from contract/ARTIFACT.md, in bytes. */
export const SIZE_WARN  = 20 * 1024 * 1024;
export const SIZE_LIMIT = 100 * 1024 * 1024;

// ── Registry entries ──────────────────────────────────────────────────────────

/** The three ways an entry can name an artifact, in precedence order. */
const SOURCES = ['repo', 'prebuilt', 'localPath'];

/**
 * Display fields that used to be duplicated into apps.json and are now read
 * from the artifact. Rejected rather than ignored: an onboarding PR that sets
 * one of these has a mistaken idea of where metadata lives, and silently
 * dropping it would leave the author waiting for a catalog card that never
 * changes.
 */
const ARTIFACT_OWNED = ['slug', 'name', 'description', 'icon', 'tags', 'entryPoint', 'pages'];

export function isIframe(app) {
  return app?.type === 'iframe';
}

/**
 * Stable identity of an artifact entry — its source.
 *
 * Keys the expansion map, so Astro can splice each artifact's apps back into the
 * registry at the position its entry occupies.
 */
export function sourceKey(app) {
  for (const field of SOURCES) if (app?.[field]) return app[field];
  throw new Error(`apps.json: an entry names no artifact — it needs one of ${SOURCES.join(', ')}`);
}

/** Filesystem-safe form of a source key, for staging directory names. */
export function stagingName(key) {
  return key.replace(/[^a-z0-9._-]+/gi, '__');
}

/**
 * Validates one registry entry against the v2 rules.
 *
 * @param {object} app
 * @param {number} index - position in apps.json, for the error message
 */
export function validateEntry(app, index) {
  const where = `apps.json[${index}]`;
  if (!app || typeof app !== 'object' || Array.isArray(app)) {
    throw new Error(`${where}: expected an object.`);
  }

  // An iframe entry has no artifact to read metadata from, so it is the one
  // place display fields still belong. See issue #10 — it is a stopgap.
  if (isIframe(app)) {
    if (!app.slug) throw new Error(`${where}: an iframe entry needs a "slug".`);
    if (!SLUG_RE.test(app.slug)) {
      throw new Error(`${where}: slug ${JSON.stringify(app.slug)} must be lowercase kebab-case.`);
    }
    if (!app.url) throw new Error(`${app.slug}: an iframe entry needs a "url".`);
    for (const field of SOURCES) {
      if (app[field]) throw new Error(`${app.slug}: an iframe entry must not also set "${field}".`);
    }
    return;
  }

  const named = SOURCES.filter((field) => app[field]);
  if (named.length === 0) {
    throw new Error(
      `${where}: needs exactly one of "repo", "prebuilt" or "localPath" — see contract/ARTIFACT.md.`,
    );
  }
  if (named.length > 1) {
    throw new Error(`${where}: names more than one source (${named.join(', ')}); pick one.`);
  }

  const present = ARTIFACT_OWNED.filter((field) => app[field] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `${where} (${sourceKey(app)}): sets ${present.map((f) => `"${f}"`).join(', ')}, which the artifact owns.\n` +
      `     Move it to ${MANIFEST} in the publishing repo — the registry records where an artifact\n` +
      `     comes from and nothing else. See contract/ARTIFACT.md.`,
    );
  }

  if (app.type !== undefined) {
    throw new Error(
      `${where} (${sourceKey(app)}): "type" is only for iframe entries. A packaged site and a set of\n` +
      `     single-page docs are both just apps in a ${MANIFEST} manifest now.`,
    );
  }
  if (app.version !== undefined && !app.repo) {
    throw new Error(`${where} (${sourceKey(app)}): "version" pins a release, so it needs "repo".`);
  }
  if (app.pack !== undefined && !app.localPath) {
    throw new Error(`${where} (${sourceKey(app)}): "pack" is the local build command, so it needs "localPath".`);
  }
  if (app.optional && app.repo) {
    throw new Error(
      `${where} (${app.repo}): "optional" is for artifacts that live outside this repo and may be absent.\n` +
      `     A "repo" entry is fetched, so a missing release is a real failure.`,
    );
  }
}

// ── Manifest ──────────────────────────────────────────────────────────────────

/**
 * Locates the manifest inside a staged artifact.
 *
 * Artifacts are packed with the manifest at the archive root, but a repo may
 * also wrap one in dist/ — accept both rather than fail on a detail of the
 * packing step that the publishing repo did not choose deliberately.
 */
export function findManifestRoot(stageDir) {
  for (const candidate of [stageDir, join(stageDir, 'dist')]) {
    if (existsSync(join(candidate, MANIFEST))) return candidate;
  }
  return null;
}

/**
 * Reads and validates a manifest's envelope.
 *
 * Per-app validation happens in expandManifest, which can also check the
 * directories on disk.
 *
 * @param {string} root   - directory containing kb-docs.json
 * @param {string} source - human-readable origin, used in error messages
 */
export function readManifest(root, source) {
  const file = join(root, MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${source}: ${MANIFEST} is not valid JSON — ${err.message}`);
  }

  if (manifest.kbVersion !== KB_VERSION) {
    throw new Error(
      `${source}: ${MANIFEST} declares kbVersion ${JSON.stringify(manifest.kbVersion)}; ` +
      `this knowledge base understands ${JSON.stringify(KB_VERSION)}.`,
    );
  }
  if (!Array.isArray(manifest.apps) || manifest.apps.length === 0) {
    throw new Error(`${source}: ${MANIFEST} lists no apps.`);
  }
  return manifest;
}

/**
 * Turns a manifest into app entries — one per app in the artifact.
 *
 * Each returned entry looks like a resolved registry app, so every downstream
 * consumer (catalog cards, masthead, routing) needs no knowledge of artifacts.
 * `appDir` is the source directory to copy into apps/{slug}/ and is stripped
 * before the entry is persisted — see toRegistryEntry.
 *
 * @param {object} entry    - the apps.json entry the artifact came from
 * @param {object} manifest - output of readManifest
 * @param {string} root     - directory the manifest was read from
 */
export function expandManifest(entry, manifest, root) {
  const source = sourceKey(entry);
  const seen = new Set();
  const apps = [];

  for (const [i, app] of manifest.apps.entries()) {
    const where = `${source}: ${MANIFEST} apps[${i}]`;

    if (typeof app?.slug !== 'string' || !SLUG_RE.test(app.slug)) {
      throw new Error(`${where} has an invalid slug ${JSON.stringify(app?.slug)} — expected lowercase kebab-case.`);
    }
    if (seen.has(app.slug)) {
      throw new Error(`${where} repeats slug "${app.slug}" — slugs must be unique within an artifact.`);
    }
    seen.add(app.slug);

    for (const field of ['name', 'description']) {
      if (typeof app[field] !== 'string' || app[field].trim() === '') {
        throw new Error(`${where} ("${app.slug}") is missing a ${field}.`);
      }
    }

    const entryPoint = app.entryPoint ?? 'index.html';
    const appDir = join(root, app.slug);
    if (!existsSync(join(appDir, entryPoint))) {
      throw new Error(
        `${where} ("${app.slug}") declares entryPoint "${entryPoint}" but ` +
        `${app.slug}/${entryPoint} is not in the artifact.`,
      );
    }

    apps.push({
      slug:        app.slug,
      name:        app.name.trim(),
      description: app.description.trim(),
      icon:        ICONS.includes(app.icon) ? app.icon : DEFAULT_ICON,
      tags:        Array.isArray(app.tags) ? app.tags.slice(0, 5) : [],
      entryPoint,
      // The navigation manifest, when the publisher supplied one. Absent means
      // the build crawls the directory instead.
      pages:       normalisePages(app.pages, appDir, where),
      // Carried through from the registry entry: the only two things apps.json
      // still gets to say about an app it did not describe.
      ...(entry.headless === undefined ? {} : { headless: entry.headless }),
      appDir,
    });
  }

  return apps;
}

/**
 * Validates and sorts a `pages` navigation manifest.
 *
 * A page whose file is missing is dropped with the entry named, not silently:
 * the manifest is authoritative when present, so a stale path would otherwise
 * produce a route that 404s at runtime rather than at build time.
 */
function normalisePages(pages, appDir, where) {
  if (!Array.isArray(pages) || pages.length === 0) return null;

  const kept = [];
  for (const [i, page] of pages.entries()) {
    if (typeof page?.title !== 'string' || typeof page?.path !== 'string') {
      throw new Error(`${where} pages[${i}] needs a "title" and a "path".`);
    }
    if (!Number.isInteger(page.order)) {
      throw new Error(`${where} pages[${i}] ("${page.title}") needs an integer "order".`);
    }
    if (!existsSync(join(appDir, page.path))) {
      throw new Error(
        `${where} pages[${i}] ("${page.title}") points at "${page.path}", which is not in the artifact.`,
      );
    }
    kept.push({ title: page.title, path: page.path, order: page.order, section: page.section ?? null });
  }
  return kept.sort((a, b) => a.order - b.order);
}

/** Drops build-only fields so the expansion map stays a plain registry fragment. */
export function toRegistryEntry({ appDir, ...entry }) {
  return entry;
}

// ── Expansion map ─────────────────────────────────────────────────────────────
// The committed apps.json cannot list the apps (they are discovered from the
// artifact), and rewriting the registry in place would make a build mutate a
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
 * Replaces every artifact entry with the apps it expanded into.
 *
 * iframe entries pass through untouched and always come straight from apps.json,
 * so editing the registry never goes stale against the map.
 *
 * @param {Array}  registry - raw apps.json contents
 * @param {object} map      - output of readExpansionMap
 * @param {(msg: string) => void} [warn]
 */
export function resolveRegistry(registry, map, warn = () => {}) {
  const resolved = [];

  for (const app of registry) {
    if (isIframe(app)) { resolved.push(app); continue; }

    const key = sourceKey(app);
    const apps = map[key];
    if (!apps || apps.length === 0) {
      // `optional` entries are expected to be missing whenever their artifact is
      // not checked out (see build-vite.js) — that is not worth a warning.
      if (!app.optional) {
        warn(`${key}: artifact has not been prepared yet — run a build to populate ${EXPANSION_FILE}`);
      }
      continue;
    }
    resolved.push(...apps);
  }

  assertUniqueSlugs(resolved);
  return resolved;
}

/**
 * Guards against two apps claiming the same URL prefix.
 *
 * A repo chooses its own slugs without seeing the rest of the registry, so a
 * collision with an existing app would otherwise silently overwrite apps/{slug}/.
 */
export function assertUniqueSlugs(apps) {
  const seen = new Map();
  for (const app of apps) {
    if (!app.slug) continue;
    if (seen.has(app.slug)) {
      throw new Error(
        `Duplicate app slug "${app.slug}": claimed by both ${describe(seen.get(app.slug))} and ` +
        `${describe(app)}. Slugs are URL prefixes and must be unique across the whole registry — ` +
        `rename one of them in the publishing repo's ${MANIFEST} and republish.`,
      );
    }
    seen.set(app.slug, app);
  }
  return apps;
}

function describe(app) {
  if (isIframe(app)) return `iframe entry "${app.name ?? app.slug}"`;
  return `app "${app.name ?? app.slug}"`;
}
