/**
 * build-vite.js — knowledge-base build orchestrator
 *
 * Usage:
 *   node scripts/build-vite.js           (downloads Release artifacts via GitHub API)
 *   node scripts/build-vite.js --local   (builds each app from local source)
 *   node scripts/build-vite.js --headless
 *
 * Pipeline:
 *   1. Fetch/build sub-app artifacts → apps/{slug}/
 *   2. Copy non-HTML sub-app assets → public/knowledge-base/{slug}/
 *      (Astro serves these as static files; HTML files are handled by the catchall page)
 *   3. Run astro build → dist/
 *      Sub-app pages are rendered by src/pages/[...path].astro via getStaticPaths.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { copyDir, stageArtifact } from './artifacts.js';
import { fetchApps } from './fetch-apps.js';
import { HOIST_DIR, hoistAppInlineScripts } from './hoist-inline-scripts.js';
import { collectHtmlFiles } from '../src/utils/apps.js';
import {
  BUNDLE_MANIFEST, bundleDirName, bundleKey, expandBundle, findBundleRoot,
  isSinglePage, readBundleManifest, resolveRegistry, toRegistryEntry, writeExpansionMap,
} from '../src/utils/single-page.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const APPS_DIR = join(ROOT, 'apps');

const LOCAL_MODE  = process.argv.includes('--local');
const HEADLESS    = process.argv.includes('--headless') || process.env.MP_HEADLESS === 'true';
const prefixArg   = process.argv.find(a => a.startsWith('--path-prefix='));
const PATH_PREFIX = prefixArg ? prefixArg.split('=').slice(1).join('=') : 'knowledge-base';

const log  = (msg) => console.log('\x1b[36m→\x1b[0m ' + msg);
const ok   = (msg) => console.log('\x1b[32m✓\x1b[0m ' + msg);
const warn = (msg) => console.warn('\x1b[33m⚠\x1b[0m  ' + msg);
const step = (msg) => console.log('\n\x1b[1m' + msg + '\x1b[0m');

/** Where `prebuilt` tarballs are unpacked before being copied into apps/. */
const STAGE_ROOT = join(ROOT, 'tmp', 'prebuilt');

/** Expands a registry path (`~` and repo-relative forms allowed) to an absolute one. */
function artifactPath(raw) {
  const expanded = raw.replace(/^~/, homedir());
  return isAbsolute(expanded) ? expanded : resolve(ROOT, expanded);
}

/** As artifactPath, but fails the build when the artifact is not there. */
function resolveArtifactPath(app, raw, label) {
  const srcPath = artifactPath(raw);
  if (!existsSync(srcPath)) fail((app.slug ?? bundleKey(app)) + ': ' + label + ' path not found: ' + srcPath);
  return srcPath;
}

/**
 * Prepares a sub-app from a prebuilt artifact instead of fetching from GitHub
 * or building from source.
 *
 * Used for hermetic E2E tests (no network, no per-app toolchain) and for any
 * registry entry that ships a `prebuilt` path. Mirrors fetch-apps.js: the dist
 * contents land in apps/{slug}/ with marketplace.json copied alongside. For a
 * `single-page` entry the artifact is a bundle instead, so it is expanded — see
 * installBundle.
 *
 * @returns {Array|null} expanded app entries for a single-page bundle, else null
 */
function preparePrebuilt(app) {
  const label    = app.slug ?? bundleKey(app);
  const srcPath  = resolveArtifactPath(app, app.prebuilt, 'prebuilt');
  const stageDir = stageArtifact(srcPath, bundleDirName(label), STAGE_ROOT, label);

  if (isSinglePage(app)) return installBundle(app, stageDir, 'prebuilt');

  const destDir = join(APPS_DIR, app.slug);
  if (existsSync(destDir)) rmSync(destDir, { recursive: true });

  // The built output is dist/ when present, otherwise the staging dir itself.
  const distDir = existsSync(join(stageDir, 'dist')) ? join(stageDir, 'dist') : stageDir;
  copyDir(distDir, destDir);

  // Copy marketplace.json (tarball root preferred, then dist/) so manifest-driven
  // routing/metadata works the same as the GitHub fetch path.
  for (const cand of [join(stageDir, 'marketplace.json'), join(distDir, 'marketplace.json')]) {
    if (existsSync(cand)) { copyFileSync(cand, join(destDir, 'marketplace.json')); break; }
  }
  ok(app.slug + ' ready (prebuilt)');
  return null;
}

/**
 * Expands a locally staged single-page bundle into one sub-app per doc.
 *
 * The GitHub path (scripts/fetch-apps.js → fetchBundle) does the same thing after
 * downloading the release asset; both share the manifest reading/validation in
 * src/utils/single-page.js so the two can't drift.
 *
 * @returns {Array} expanded app entries, ready for the expansion map
 */
function installBundle(app, stageDir, sourceLabel) {
  const key = bundleKey(app);
  const bundleRoot = findBundleRoot(stageDir);
  if (!bundleRoot) {
    fail(
      key + ': single-page artifact has no ' + BUNDLE_MANIFEST + ' at its root. ' +
      'Publish it with AbsaOSS/knowledge-base/actions/publish-single-page-docs — see contract/SINGLE_PAGE.md.',
    );
  }

  const docs = expandBundle(app, readBundleManifest(bundleRoot, key), bundleRoot);
  for (const doc of docs) {
    const destDir = join(APPS_DIR, doc.slug);
    if (existsSync(destDir)) rmSync(destDir, { recursive: true });
    copyDir(doc.docDir, destDir);
    ok(doc.slug + ' ready (single-page doc, ' + sourceLabel + ')');
  }
  return docs.map(toRegistryEntry);
}

function fail(msg) { throw new Error(msg); }

async function build() {
  const startMs = Date.now();
  const modeLabel = [LOCAL_MODE && 'local', HEADLESS && 'headless'].filter(Boolean).join(', ');
  console.log('\n\x1b[1m\x1b[35m▶ knowledge-base build' + (modeLabel ? ' (' + modeLabel + ')' : '') + '\x1b[0m\n');

  const allEntries = JSON.parse(readFileSync(join(ROOT, 'apps.json'), 'utf8'));

  // Entries flagged `"optional": true` are local-development conveniences whose
  // artifact lives outside this repo — the sibling example repo, say. When it is
  // absent (CI, a fresh clone) the entry is skipped with a warning rather than
  // failing the build. Everything else still hard-fails on a missing artifact,
  // so a lost fixture can never quietly produce an empty deployment.
  const registeredApps = allEntries.filter(app => {
    const artifact = app.prebuilt ?? app.localPath;
    if (!app.optional || !artifact || existsSync(artifactPath(artifact))) return true;
    warn((app.slug ?? artifact) + ': optional entry skipped — artifact not found at ' + artifactPath(artifact));
    return false;
  });

  // Validate registry entries up front (fail fast with a clear message).
  const bundleKeys = new Set();
  for (const app of registeredApps) {
    if (isSinglePage(app)) {
      // A single-page entry carries no slug or per-doc metadata — the docs (and
      // their slugs) are discovered from the artifact's bundle.json.
      const key = bundleKey(app);
      if (bundleKeys.has(key)) fail('apps.json: two "single-page" entries both point at ' + key);
      bundleKeys.add(key);
      continue;
    }
    if (!app.slug) fail('apps.json: an entry is missing "slug"');
    if (app.type === 'iframe') {
      if (!app.url) fail(app.slug + ': iframe entry requires a "url"');
      if (app.temporary) warn(app.slug + ': temporary iframe entry — migrate to a headless package when ready');
    } else if (!app.prebuilt && !app.localPath && !app.repo) {
      fail(app.slug + ': packaged entry needs one of "repo", "localPath", or "prebuilt"');
    }
  }

  // iframe entries have no artifact to fetch/build — they render a single route
  // (see src/pages/[...path].astro). Only packaged apps go through the pipeline.
  const iframeApps   = registeredApps.filter(a => a.type === 'iframe');
  const packagedApps = registeredApps.filter(a => a.type !== 'iframe');

  // 1. Prepare apps/ directory
  step('1/3  Preparing sub-app artifacts → apps/');
  mkdirSync(APPS_DIR, { recursive: true });

  for (const app of iframeApps) ok(app.slug + ' registered (iframe → ' + app.url + ')');

  // What each single-page bundle expanded into, keyed by bundleKey. Written to
  // apps/.single-page.json so Astro resolves the same registry the build did.
  const expansions = {};
  const record = (key, docs) => { (expansions[key] ??= []).push(...docs); };

  // Apps shipping a `prebuilt` artifact are prepared locally regardless of mode
  // (hermetic — no network, no per-app build). The rest go through fetch/local.
  const prebuiltApps  = packagedApps.filter(a => a.prebuilt);
  const remainingApps = packagedApps.filter(a => !a.prebuilt);

  for (const app of prebuiltApps) {
    const docs = preparePrebuilt(app);
    if (docs) record(bundleKey(app), docs);
  }

  if (remainingApps.length > 0) {
    if (LOCAL_MODE) {
      for (const app of remainingApps) {
        if (!app.localPath) { warn((app.slug ?? bundleKey(app)) + ': no localPath, skipping'); continue; }
        const srcDir = app.localPath.replace(/^~/, homedir());

        // A local single-page bundle is already built output — expand it in place
        // rather than running a per-app build script it does not have.
        if (isSinglePage(app)) {
          record(bundleKey(app), installBundle(app, resolveArtifactPath(app, app.localPath, 'localPath'), 'local'));
          continue;
        }

        const buildScript = HEADLESS ? 'build:headless' : 'build';
        log('Building ' + app.slug + ' from ' + app.localPath + '…');
        execSync('npm run ' + buildScript, { cwd: srcDir, stdio: 'inherit' });

        const srcDist = join(srcDir, 'dist');
        const destDir = join(APPS_DIR, app.slug);
        if (existsSync(destDir)) rmSync(destDir, { recursive: true });
        copyDir(srcDist, destDir);
        const manifest = join(srcDir, 'marketplace.json');
        if (existsSync(manifest)) copyFileSync(manifest, join(destDir, 'marketplace.json'));
        ok(app.slug + ' ready (local)');
      }
    } else {
      for (const entry of await fetchApps(remainingApps)) {
        // Only single-page entries carry a bundleKey; packaged apps are already
        // fully described by their apps.json entry.
        const { bundleKey: key, ...rest } = entry;
        if (key) record(key, [toRegistryEntry(rest)]);
      }
    }
  }

  // Persist the expansion and resolve the registry the rest of the build works
  // from. resolveRegistry also enforces globally unique slugs, so a doc bundle
  // can never quietly take over another app's URL prefix.
  writeExpansionMap(ROOT, expansions);
  const resolvedApps = resolveRegistry(registeredApps, expansions, warn);
  const packagedResolved = resolvedApps.filter(a => a.type !== 'iframe');

  // 1b. Hoist inline <script> bodies out of sub-app HTML into files.
  //     The marketplace serves script-src 'self'; an inline script anywhere would
  //     force 'unsafe-inline' on every page. Bundles published before the action
  //     stopped emitting one still contain it, and this repo does not control
  //     when those repos re-publish — so it is fixed here rather than assumed.
  step('1b/4  Hoisting inline scripts → files');
  let hoisted = 0;
  let droppedBootstraps = 0;
  for (const app of resolvedApps.filter(a => a.type !== 'iframe')) {
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
    for (const entry of readdirSync(src).sort()) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) copyAssets(s, d, slug);
      else if (!entry.endsWith('.html')) {
        copyFileSync(s, d);
        if (entry.endsWith('.css')) {
          const css = readFileSync(d, 'utf8');
          // url(/path) | url('/path') | url("/path") → url(/{prefix}/{slug}/path).
          // The (?!\/) guard skips protocol-relative //host/…; data: and #ref
          // never match, since neither starts with a slash.
          const rewritten = css.replace(
            /url\(\s*(['"]?)\/(?!\/)/g,
            'url($1/' + PATH_PREFIX + '/' + slug + '/',
          );
          if (rewritten !== css) writeFileSync(d, rewritten);
        }
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
  const env = {
    ...process.env,
    MP_PREFIX:   PATH_PREFIX,
    MP_HEADLESS: HEADLESS ? 'true' : 'false',
  };
  execSync('npx astro build', { cwd: ROOT, stdio: 'inherit', env });
  ok('Astro build complete');

  // Publish dist/style.css as an alias of the marketplace stylesheet.
  //
  // Pages do not need it: Astro injects the <link> from Base.astro's CSS import,
  // with whatever content-hashed name the bundle got. The alias exists because
  // /{prefix}/style.css is a URL this deployment has served for a long time and
  // something outside this repository may still ask for it.
  //
  // The bundle is identified by *use*, not by filename: it is the local
  // stylesheet the marketplace's own landing page loads. That is the definition
  // of "the marketplace stylesheet", and it cannot drift from what the pages
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
        'Expected the landing page to load exactly one local stylesheet — the marketplace bundle — ' +
        'but found ' + hrefs.length + (hrefs.length ? ': ' + hrefs.join(', ') : '') +
        '. dist/style.css can only alias an unambiguous one.',
      );
    }

    const bundle = join(distRoot, hrefs[0].slice(('/' + PATH_PREFIX).length));
    if (!existsSync(bundle)) fail('The landing page references ' + hrefs[0] + ', which is not in dist/.');
    copyFileSync(bundle, join(distRoot, 'style.css'));
    ok('Marketplace CSS ' + hrefs[0] + ' aliased → dist/style.css');
  }

  // 4. Summary
  step('4/4  Build complete');
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const slugs = readdirSync(APPS_DIR).filter(d => statSync(join(APPS_DIR, d)).isDirectory());
  const appList = slugs.map(s => '    \u2022 \x1b[36m' + s + '\x1b[0m → dist/' + s + '/').join('\n');
  console.log('\n\x1b[32m✓\x1b[0m \x1b[1m' + (slugs.length + iframeApps.length) + ' app(s) integrated\x1b[0m in ' + elapsed + 's\n\n  Apps:\n' + appList + '\n  Prefix: \x1b[33m' + PATH_PREFIX + '\x1b[0m\n');
}

build().catch(err => {
  console.error('\n\x1b[31m✗ Build failed:\x1b[0m', err.message);
  process.exit(1);
});
