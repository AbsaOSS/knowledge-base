/**
 * build-vite.js — knowledge-base build orchestrator
 *
 * Usage:
 *   node scripts/build-vite.js           (downloads Release artifacts via GitHub API)
 *   node scripts/build-vite.js --local   (builds each app from local source)
 *   node scripts/build-vite.js --headless
 *
 * Pipeline:
 *   1.  Fetch/build sub-app artifacts → apps/{slug}/
 *   1b. Hoist inline <script> bodies → apps/{slug}/_kb-inline/*.js, and delete
 *       any theme bootstrap (light only)
 *   2.  Copy non-HTML sub-app assets → public/{slug}/
 *       (Astro serves these as static files; HTML files are handled by the catchall page)
 *   3.  Run astro build → dist/
 *       Sub-app pages are rendered by src/pages/[...path].astro via getStaticPaths.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, linkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { copyDir, extractTarball, stageArtifact } from './artifacts.js';
import { downloadArtifact } from './fetch-apps.js';
import { HOIST_DIR, hoistAppInlineScripts } from './hoist-inline-scripts.js';
import { collectHtmlFiles } from '../src/utils/apps.js';
import { PATH_PREFIX, REGISTRY_FILE } from '../src/utils/config.js';
import {
  ARTIFACT_NAME, MANIFEST, expandManifest, findManifestRoot, isIframe,
  readManifest, resolveRegistry, sourceKey, stagingName, toRegistryEntry,
  validateEntry, writeExpansionMap,
} from '../src/utils/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_DIR = join(ROOT, 'apps');

const LOCAL_MODE = process.argv.includes('--local');
const HEADLESS   = process.argv.includes('--headless') || process.env.KB_HEADLESS === 'true';

/**
 * Production mode: every convenience that makes a local build forgiving is an
 * error instead.
 *
 * The registry this repo ships is a *development* registry — a vendored fixture
 * and an optional sibling checkout — and the flags that make it work (`prebuilt`,
 * `localPath`, `optional`) are exactly the ones that would let a deployment ship
 * a half-empty knowledge base without failing. A real deployment builds from
 * released artifacts only, and an entry that yields nothing is a broken deploy,
 * not a warning nobody reads. See contract/DEPLOYMENT.md.
 */
const STRICT = process.argv.includes('--strict') || process.env.KB_STRICT === 'true';

const log  = (msg) => console.log('\x1b[36m→\x1b[0m ' + msg);
const ok   = (msg) => console.log('\x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.warn('\x1b[33m⚠\x1b[0m  ' + msg);
const step = (msg) => console.log('\n\x1b[1m' + msg + '\x1b[0m');

/** Default command a `localPath` entry runs to produce its artifact. */
const DEFAULT_PACK = 'npm run pack:kb';

/** Where artifacts are unpacked before their apps are copied into apps/. */
const STAGE_ROOT = join(ROOT, 'tmp', 'prebuilt');

/** Expands a registry path (`~` and repo-relative forms allowed) to an absolute one. */
function artifactPath(raw) {
  const expanded = raw.replace(/^~/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(ROOT, expanded);
}

/** As artifactPath, but fails the build when the artifact is not there. */
function resolveArtifactPath(app, raw, label) {
  const srcPath = artifactPath(raw);
  if (!existsSync(srcPath)) fail(sourceKey(app) + ': ' + label + ' path not found: ' + srcPath);
  return srcPath;
}

/**
 * Puts an entry's artifact on disk as a directory, whatever its source.
 *
 * This is the only place the three sources differ. Everything after it —
 * reading the manifest, validating it, copying apps into apps/{slug}/ — is
 * installArtifact, run identically for all of them. The GitHub path and the
 * prebuilt path used to be separate implementations of the same idea and drifted
 * apart repeatedly; there is now nothing left to drift.
 *
 * @returns {Promise<{stageDir: string, label: string, releaseTag?: string}>}
 */
async function stageEntry(app) {
  const key = sourceKey(app);

  if (app.prebuilt) {
    const srcPath = resolveArtifactPath(app, app.prebuilt, 'prebuilt');
    return { stageDir: stageArtifact(srcPath, stagingName(key), STAGE_ROOT, key), label: 'prebuilt' };
  }

  if (app.localPath) {
    const checkout = resolveArtifactPath(app, app.localPath, 'localPath');

    // A local checkout is source, not output. Run whatever the repo uses to
    // produce its artifact and then treat the result exactly like a prebuilt
    // one. The command is per-entry because doc repos are not all Node: the
    // example repo is Python and mkdocs, and the old hard-coded
    // `npm run build:headless` simply could not run there.
    if (app.pack !== false) {
      const command = typeof app.pack === 'string' ? app.pack : DEFAULT_PACK;
      log(`Packing ${key} with \`${command}\`…`);
      execSync(command, { cwd: checkout, stdio: 'inherit' });
    }

    const artifact = join(checkout, ARTIFACT_NAME);
    if (!existsSync(artifact)) {
      fail(
        `${key}: no ${ARTIFACT_NAME} in the checkout after packing.\n` +
        `     A "localPath" entry runs its pack command (\`${app.pack ?? DEFAULT_PACK}\`) and then reads\n` +
        `     ${ARTIFACT_NAME} from the checkout root, the same file the repo publishes to a release.\n` +
        `     Set "pack" to the right command, or "pack": false if the artifact is already built.`,
      );
    }
    return { stageDir: stageArtifact(artifact, stagingName(key), STAGE_ROOT, key), label: 'local' };
  }

  const { tarPath, releaseTag } = await downloadArtifact(app);
  const stageDir = join(STAGE_ROOT, stagingName(key));
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });
  extractTarball(tarPath, stageDir, `${key}@${releaseTag}`);
  return { stageDir, label: releaseTag, releaseTag };
}

/**
 * Installs every app an artifact declares into apps/{slug}/.
 *
 * @returns {Array} expanded app entries, ready for the expansion map
 */
function installArtifact(app, stageDir, label) {
  const key  = sourceKey(app);
  const root = findManifestRoot(stageDir);
  if (!root) {
    fail(
      `${key}: the artifact has no ${MANIFEST} at its root.\n` +
      `     A release must carry ${ARTIFACT_NAME} packed by an AbsaOSS/knowledge-base publishing\n` +
      `     action — see contract/ARTIFACT.md.`,
    );
  }

  const manifest = readManifest(root, key);
  const apps     = expandManifest(app, manifest, root);

  // Anything in the archive that no app claims is not served. Saying so is the
  // difference between a doc that is missing and a doc nobody realises was
  // never registered.
  warnOnUnclaimedMembers(root, apps, key);

  for (const entry of apps) {
    const destDir = join(APPS_DIR, entry.slug);
    if (existsSync(destDir)) rmSync(destDir, { recursive: true });
    copyDir(entry.appDir, destDir);

    const html = readFileSync(join(destDir, entry.entryPoint), 'utf8');
    checkHeadlessMarker(html, `${entry.slug}: ${entry.entryPoint}`);

    ok(`${entry.slug} ready (${label})`);
  }
  return apps.map(toRegistryEntry);
}

/** The marker a headless artifact must carry on `<html>`. */
const HEADLESS_MARKER = 'data-kb-headless="true"';
/** Its pre-rename spelling — see issue #77. */
const LEGACY_HEADLESS_MARKER = 'data-mp-headless';

/**
 * Warns when an artifact's entry point is not marked headless.
 *
 * A bundle published before the rename carries `data-mp-headless`, which is
 * indistinguishable from "not headless at all" to every downstream consumer.
 * Saying so explicitly is the difference between a publisher re-reading the
 * contract and a publisher re-reading their build script.
 *
 * This used to run only on the GitHub fetch path, so the sources CI actually
 * uses were never checked.
 */
function checkHeadlessMarker(html, label) {
  if (html.includes(HEADLESS_MARKER)) return;
  if (html.includes(LEGACY_HEADLESS_MARKER)) {
    warn(
      `${label} carries ${LEGACY_HEADLESS_MARKER}, which this knowledge base no longer reads. ` +
      `The artifact was produced against the pre-rename contract — republish it with a current ` +
      `AbsaOSS/knowledge-base action so it emits ${HEADLESS_MARKER}.`,
    );
    return;
  }
  warn(`${label} is missing ${HEADLESS_MARKER} on <html> — see contract/HEADLESS_RULES.md.`);
}

/**
 * Reports archive members that belong to no declared app.
 *
 * contract/ARTIFACT.md allows only the manifest and the declared `<slug>/`
 * directories. A stray top-level file is not served, and a stray *directory*
 * usually means a doc was dropped from the manifest but not from the build.
 */
function warnOnUnclaimedMembers(root, apps, key) {
  const claimed = new Set(apps.map((a) => a.slug));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === MANIFEST) continue;
    if (entry.isDirectory() && claimed.has(entry.name)) continue;
    warn(
      `${key}: ${entry.isDirectory() ? 'directory' : 'file'} "${entry.name}" is in the artifact but ` +
      `no app in ${MANIFEST} claims it — it will not be served.`,
    );
  }
}

function fail(msg) { throw new Error(msg); }

/**
 * Hardlinks a file, copying only if the filesystem will not link it.
 *
 * Every sub-app asset is already written twice — once by the tarball extraction
 * into apps/{slug}/, once by Astro's static copy of public/ into dist/. The hop
 * in between does not need a third set of bytes, and for an artifact carrying
 * images or fonts that is the largest of the three. A link is not possible
 * across devices (EXDEV) or on a filesystem without hardlink support, hence the
 * fallback rather than a bare linkSync.
 */
function linkOrCopy(src, dest) {
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

async function build() {
  const startMs = Date.now();
  const modeLabel = [LOCAL_MODE && 'local', HEADLESS && 'headless', STRICT && 'strict'].filter(Boolean).join(', ');
  console.log('\n\x1b[1m\x1b[35m▶ knowledge-base build' + (modeLabel ? ' (' + modeLabel + ')' : '') + '\x1b[0m\n');

  // resolve, not join: KB_REGISTRY may be absolute — a deployment repo owns its
  // registry and it is checked out beside this repo, not inside it.
  const registryPath = resolve(ROOT, REGISTRY_FILE);
  if (!existsSync(registryPath)) fail(`registry not found: ${registryPath} (set KB_REGISTRY to point elsewhere)`);
  const allEntries = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(allEntries)) fail(`${REGISTRY_FILE}: expected an array of entries.`);

  // Validate every entry before touching the network or the filesystem, so a
  // malformed registry fails on the registry rather than halfway through a
  // download. See src/utils/registry.js for the rules.
  allEntries.forEach(validateEntry);

  const seenSources = new Set();
  for (const app of allEntries) {
    if (isIframe(app)) {
      if (app.temporary) warn(`${app.slug}: temporary iframe entry — migrate to a packaged artifact when ready`);
      continue;
    }
    const key = sourceKey(app);
    if (seenSources.has(key)) fail(`${REGISTRY_FILE}: two entries both point at ${key}.`);
    seenSources.add(key);

    if (STRICT) {
      // A deployment must be reproducible from released artifacts alone. A
      // local path is a developer's working copy, and `optional` is permission
      // to ship without an app nobody noticed was missing.
      for (const field of ['prebuilt', 'localPath']) {
        if (app[field]) {
          fail(
            `${key}: "${field}" is not allowed in a strict build.\n` +
            `     A deployment registry lists released artifacts — use "repo" (with an optional\n` +
            `     "version") so the build is reproducible from what is published. See contract/DEPLOYMENT.md.`,
          );
        }
      }
      if (app.optional) {
        fail(
          `${key}: "optional" is not allowed in a strict build — a registered app that cannot be\n` +
          `     fetched is a broken deployment, not something to skip with a warning.`,
        );
      }
    }
  }

  if (STRICT && allEntries.length === 0) {
    fail(`${REGISTRY_FILE} is empty — a strict build will not publish an empty knowledge base.`);
  }

  // Entries flagged `"optional": true` are local-development conveniences whose
  // artifact lives outside this repo — the sibling example repo, say. When it is
  // absent (CI, a fresh clone) the entry is skipped with a warning rather than
  // failing the build. Everything else still hard-fails on a missing artifact,
  // so a lost fixture can never quietly produce an empty deployment.
  const registeredApps = allEntries.filter(app => {
    const artifact = app.prebuilt ?? app.localPath;
    if (!app.optional || !artifact || existsSync(artifactPath(artifact))) return true;
    warn(`${sourceKey(app)}: optional entry skipped — artifact not found at ${artifactPath(artifact)}`);
    return false;
  });

  // iframe entries have no artifact to fetch or build — they render a single
  // route (see src/pages/[...path].astro).
  const iframeApps   = registeredApps.filter(isIframe);
  const artifactApps = registeredApps.filter(a => !isIframe(a));

  // 1. Prepare apps/ directory
  step('1/4  Preparing sub-app artifacts → apps/');
  mkdirSync(APPS_DIR, { recursive: true });

  for (const app of iframeApps) ok(app.slug + ' registered (iframe → ' + app.url + ')');

  // What each artifact expanded into, keyed by its source. Written to
  // apps/.registry.json so Astro resolves the same registry the build did.
  const expansions = {};

  /** source → version → slugs, for the deployment's audit trail. */
  const provenance = [];

  for (const app of artifactApps) {
    const key = sourceKey(app);

    // `prebuilt` artifacts are staged locally regardless of mode — that is what
    // makes CI hermetic. `--local` only changes what a `repo` entry means: build
    // it from the checkout beside this one rather than downloading a release.
    if (LOCAL_MODE && app.repo && !app.localPath) {
      warn(`${key}: --local was requested but the entry names no localPath — skipping.`);
      continue;
    }

    console.log('\n\x1b[1m[' + key + ']\x1b[0m');
    const { stageDir, label } = await stageEntry(app);
    expansions[key] = installArtifact(app, stageDir, label);

    // An entry that produced nothing means a registered app is silently absent
    // from the deployment. Locally that is a warning; in production it is the
    // difference between "the docs moved" and "the docs are gone".
    if (STRICT && expansions[key].length === 0) {
      fail(`${key}: produced no apps — a registered artifact must publish at least one.`);
    }
    provenance.push({ key, label, slugs: expansions[key].map((a) => a.slug) });
  }

  // Persist the expansion and resolve the registry the rest of the build works
  // from. resolveRegistry also enforces globally unique slugs, so one artifact
  // can never quietly take over another app's URL prefix.
  writeExpansionMap(ROOT, expansions);
  const resolvedApps = resolveRegistry(registeredApps, expansions, warn);
  const packagedResolved = resolvedApps.filter(a => !isIframe(a));

  // 1b. Hoist inline <script> bodies out of sub-app HTML into files.
  //     The knowledge base serves script-src 'self'; an inline script anywhere would
  //     force 'unsafe-inline' on every page. Bundles published before the action
  //     stopped emitting one still contain it, and this repo does not control
  //     when those repos re-publish — so it is fixed here rather than assumed.
  step('1b/4  Hoisting inline scripts → files');
  let hoisted = 0;
  let droppedBootstraps = 0;
  for (const app of resolvedApps.filter(a => !isIframe(a))) {
    const appDir = join(APPS_DIR, app.slug);
    if (!existsSync(appDir)) continue;
    const { hoisted: count, dropped } = hoistAppInlineScripts(appDir, collectHtmlFiles(appDir));
    hoisted += count;
    droppedBootstraps += dropped;
    if (count > 0) ok(app.slug + ': ' + count + ' inline script(s) → ' + HOIST_DIR + '/');
    // Light-only: a hoisted theme bootstrap would run and re-add `dark`, so it
    // is deleted here instead — transform.js can only strip it while inline.
    if (dropped > 0) ok(app.slug + ': ' + dropped + ' theme bootstrap(s) dropped (light-only)');
  }
  if (hoisted === 0 && droppedBootstraps === 0) log('No inline scripts found — every artifact is already CSP-clean');

  // 2. Copy non-HTML sub-app assets → public/{slug}/ so Astro copies them to dist/{slug}/
  //    HTML files are excluded — they're handled by src/pages/[...path].astro.
  step('2/4  Copying sub-app assets → public/');
  const PUBLIC_ROOT = join(ROOT, 'public');
  mkdirSync(PUBLIC_ROOT, { recursive: true });

  // Clean only known slug dirs so user-owned public/ files (favicon, robots.txt…) are preserved
  for (const app of packagedResolved) {
    const slugDir = join(PUBLIC_ROOT, app.slug);
    if (existsSync(slugDir)) rmSync(slugDir, { recursive: true });
  }

  /**
   * Copies a sub-app's non-HTML assets, rewriting root-relative CSS url()
   * references on the way through.
   *
   * A sub-app's CSS is authored for the root of its own site, so `url(/fonts/x)`
   * means "this app's /fonts/x" — but the app is served from
   * /{prefix}/{slug}/. The rewrite targets that absolute path directly rather
   * than a relative hop: a relative `../` is only correct for a stylesheet
   * exactly one directory deep, and copyAssets recurses to every depth, so
   * `{slug}/style.css` used to climb out of the app entirely and
   * `{slug}/assets/css/a.css` landed one level short (#49). An absolute target
   * needs no depth arithmetic and matches what transform.js does for HTML.
   */
  function copyAssets(src, dest, slug) {
    mkdirSync(dest, { recursive: true });
    // withFileTypes: the entry type comes out of the directory read that already
    // happened, instead of a statSync syscall per file — and a symlink reports as
    // one rather than as whatever it points at.
    const entries = readdirSync(src, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const s = join(src, entry.name);
      const d = join(dest, entry.name);

      if (entry.isDirectory()) { copyAssets(s, d, slug); continue; }
      if (!entry.isFile() || entry.name.endsWith('.html')) continue;

      if (entry.name.endsWith('.css')) {
        // A real copy, not a link: the rewrite below edits the destination in
        // place, and a hardlink would write that edit back into apps/{slug}/.
        copyFileSync(s, d);
        const css = readFileSync(d, 'utf8');
        // url(/path) | url('/path') | url("/path") → url(/{prefix}/{slug}/path).
        // The (?!\/) guard skips protocol-relative //host/…; data: and #ref
        // never match, since neither starts with a slash.
        const rewritten = css.replace(
          /url\(\s*(['"]?)\/(?!\/)/g,
          'url($1/' + PATH_PREFIX + '/' + slug + '/',
        );
        if (rewritten !== css) writeFileSync(d, rewritten);
      } else {
        linkOrCopy(s, d);
      }
    }
  }

  for (const app of packagedResolved) {
    const srcDir = join(APPS_DIR, app.slug);
    if (!existsSync(srcDir)) { warn(app.slug + ': apps/ dir missing, skipping asset copy'); continue; }
    copyAssets(srcDir, join(PUBLIC_ROOT, app.slug), app.slug);
    ok(app.slug + ' assets → public/' + app.slug + '/');
  }

  // 3. Run Astro build
  step('3/4  Running astro build');
  // Always explicit: src/utils/config.js treats an unset KB_HEADLESS as
  // standalone, and a build that says "--headless" must not depend on that.
  const env = { ...process.env, KB_HEADLESS: HEADLESS ? 'true' : 'false' };
  execSync('npx astro build', { cwd: ROOT, stdio: 'inherit', env });
  ok('Astro build complete');

  // Publish dist/style.css as an alias of the knowledge base stylesheet.
  //
  // Pages do not need it: Astro injects the <link> from Base.astro's CSS import,
  // with whatever content-hashed name the bundle got. The alias exists because
  // /{prefix}/style.css is a URL this deployment has served for a long time and
  // something outside this repository may still ask for it.
  //
  // The bundle is identified by *use*, not by filename: it is the local
  // stylesheet the knowledge base's own landing page loads. That is the definition
  // of "the knowledge base stylesheet", and it cannot drift from what the pages
  // actually reference the way a filename pattern could (#50).
  const distRoot = join(ROOT, 'dist');
  if (existsSync(distRoot)) {
    const landing = join(distRoot, 'index.html');
    if (!existsSync(landing)) fail('No dist/index.html — the landing page did not build.');

    const hrefs = [...readFileSync(landing, 'utf8').matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)]
      .map(tag => tag[0].match(/\bhref="([^"]+)"/)?.[1])
      .filter(href => href?.startsWith('/' + PATH_PREFIX + '/'));

    if (hrefs.length !== 1) {
      fail(
        'Expected the landing page to load exactly one local stylesheet — the knowledge base bundle — ' +
        'but found ' + hrefs.length + (hrefs.length ? ': ' + hrefs.join(', ') : '') +
        '. dist/style.css can only alias an unambiguous one.',
      );
    }

    const bundle = join(distRoot, hrefs[0].slice(('/' + PATH_PREFIX).length));
    if (!existsSync(bundle)) fail('The landing page references ' + hrefs[0] + ', which is not in dist/.');
    copyFileSync(bundle, join(distRoot, 'style.css'));
    ok('Knowledge base CSS ' + hrefs[0] + ' aliased → dist/style.css');
  }

  // 4. Summary
  step('4/4  Build complete');
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const slugs = readdirSync(APPS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const appList = slugs.map(s => '    \u2022 \x1b[36m' + s + '\x1b[0m → dist/' + s + '/').join('\n');
  console.log('\n\x1b[32m✓\x1b[0m \x1b[1m' + (slugs.length + iframeApps.length) + ' app(s) integrated\x1b[0m in ' + elapsed + 's\n\n  Apps:\n' + appList + '\n  Prefix: \x1b[33m' + PATH_PREFIX + '\x1b[0m\n');

  writeProvenance(provenance, iframeApps);
}

/**
 * Records what this build was actually assembled from.
 *
 * A deployment image is opaque once it is pushed: "the docs are wrong" needs an
 * answer to "which release of which repo produced this page", and the registry
 * alone cannot answer it because `latest` means something different every day.
 * Written next to dist/ and rendered into the workflow's job summary.
 */
function writeProvenance(entries, iframeApps) {
  const manifest = {
    builtAt: new Date().toISOString(),
    registry: REGISTRY_FILE,
    strict: STRICT,
    headless: HEADLESS,
    sources: entries.map(({ key, label, slugs }) => ({ source: key, version: label, slugs })),
    iframes: iframeApps.map((a) => ({ slug: a.slug, url: a.url })),
  };
  writeFileSync(join(ROOT, 'dist', 'kb-build.json'), JSON.stringify(manifest, null, 2) + '\n');

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  const rows = entries.flatMap(({ key, label, slugs }) =>
    slugs.map((slug) => `| \`${slug}\` | \`${key}\` | \`${label}\` |`));
  for (const app of iframeApps) rows.push(`| \`${app.slug}\` | iframe | ${app.url} |`);

  appendFileSync(summaryFile,
    `### Knowledge base build\n\n` +
    `Registry \`${REGISTRY_FILE}\`${STRICT ? ' (strict)' : ''}\n\n` +
    `| App | Source | Version |\n|---|---|---|\n${rows.join('\n')}\n`);
}

build().catch(err => {
  console.error('\n\x1b[31m✗ Build failed:\x1b[0m', err.message);
  process.exit(1);
});
