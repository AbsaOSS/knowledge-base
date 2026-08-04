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

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, resolve, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fetchApps } from './fetch-apps.js';
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

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src).sort()) {
    const srcPath  = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) copyDir(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}

/**
 * Materialises a local artifact into a staging directory.
 *
 * The artifact may be a `.tar.gz` tarball (as published to GitHub Releases) or a
 * directory. Tarballs are extracted under tmp/prebuilt/{name}/; directories are
 * used in place.
 */
function stageArtifact(srcPath, name) {
  if (!statSync(srcPath).isFile()) return srcPath;

  const stageDir = join(ROOT, 'tmp', 'prebuilt', name);
  if (existsSync(stageDir)) rmSync(stageDir, { recursive: true });
  mkdirSync(stageDir, { recursive: true });
  // Portable across GNU tar (git-bash) and bsdtar (Windows System32): GNU tar
  // parses a leading "C:" in the ARCHIVE name as a remote host, so run from the
  // tarball's dir and pass only its basename to -f (the -C target is not parsed
  // that way). This avoids --force-local, which bsdtar rejects.
  const posix = (p) => p.replace(/\\/g, '/');
  execSync('tar -xzf "' + basename(srcPath) + '" -C "' + posix(stageDir) + '"',
    { cwd: dirname(srcPath), stdio: 'pipe' });
  return stageDir;
}

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
  const srcPath  = resolveArtifactPath(app, app.prebuilt, 'prebuilt');
  const stageDir = stageArtifact(srcPath, bundleDirName(app.slug ?? bundleKey(app)));

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

  function copyAssets(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src).sort()) {
      const s = join(src, entry);
      const d = join(dest, entry);
      if (statSync(s).isDirectory()) copyAssets(s, d);
      else if (!entry.endsWith('.html')) {
        copyFileSync(s, d);
        // Rewrite root-relative url() references in CSS bundles so they resolve
        // correctly when served from a sub-path (e.g. /knowledge-base/{slug}/_astro/).
        // Astro/Vite preserves absolute url(/) paths verbatim; from _astro/*.css
        // one level up (../) is the slug root, so ../fonts/ becomes
        // /knowledge-base/{slug}/fonts/ — matching where static assets are served.
        if (entry.endsWith('.css')) {
          let css = readFileSync(d, 'utf8');
          // url(/path) | url('/path') | url("/path") → url(../path) etc.
          const rewritten = css.replace(/url\(\s*(['"]?)\/(?!\/)/g, 'url($1../');
          if (rewritten !== css) writeFileSync(d, rewritten);
        }
      }
    }
  }

  for (const app of packagedResolved) {
    const srcDir = join(APPS_DIR, app.slug);
    if (!existsSync(srcDir)) { warn(app.slug + ': apps/ dir missing, skipping asset copy'); continue; }
    copyAssets(srcDir, join(PUBLIC_ROOT, app.slug));
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

  // Sub-app pages hardcode the marketplace stylesheet at /__wf/{prefix}/style.css,
  // which the gateway/nginx/preview rewrite to /{prefix}/style.css → dist/style.css.
  // Astro can emit that bundle with a numeric suffix (e.g. style2.css) when the
  // forced "style.css" asset name clashes, which would 404 the sub-app CSS. Alias
  // the bundled css to a stable dist/style.css so the reference always resolves.
  const distRoot  = join(ROOT, 'dist');
  const stableCss = join(distRoot, 'style.css');
  if (existsSync(distRoot) && !existsSync(stableCss)) {
    const rootCss = readdirSync(distRoot).filter(f => /^style\d*\.css$/.test(f));
    if (rootCss.length > 0) {
      copyFileSync(join(distRoot, rootCss[0]), stableCss);
      ok('Marketplace CSS aliased ' + rootCss[0] + ' → style.css');
    } else {
      warn('No bundled marketplace CSS at dist root — /' + PATH_PREFIX + '/style.css may 404');
    }
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
