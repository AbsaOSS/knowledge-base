/**
 * fetch-apps.js
 *
 * Downloads the latest (or pinned) GitHub Release artifact for each app in apps.json.
 * Requires either:
 *   - GITHUB_TOKEN env variable, OR
 *   - `gh` CLI authenticated (used as fallback)
 *
 * Artifacts are extracted to apps/{slug}/ (the Vite source directory for sub-apps).
 * Legacy: also keeps tmp/apps/{slug}/ populated for non-Vite paths.
 */

import { execSync, spawnSync } from 'child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  BUNDLE_MANIFEST, bundleDirName, bundleKey, expandBundle,
  findBundleRoot, isSinglePage, readBundleManifest, toRegistryEntry,
} from '../src/utils/single-page.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
// Primary output: apps/{slug}/ — consumed by the Vite build and dev server
const APPS_DIR  = join(ROOT, 'apps');
// Legacy output kept for compatibility with old build.js path
const TMP_DIR   = join(ROOT, 'tmp', 'apps');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_BASE     = 'https://api.github.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(`  \x1b[36m→\x1b[0m ${msg}\n`); }
function warn(msg) { process.stderr.write(`  \x1b[33m⚠\x1b[0m  ${msg}\n`); }
function ok(msg)   { process.stdout.write(`  \x1b[32m✓\x1b[0m ${msg}\n`); }
function fail(msg) { throw new Error(`\x1b[31m✗\x1b[0m ${msg}`); }

/**
 * Makes a GitHub API request. Uses GITHUB_TOKEN when available, otherwise
 * delegates to `gh api` CLI so developers don't need to set tokens locally.
 */
function ghApi(path) {
  if (GITHUB_TOKEN) {
    const res = execSync(
      `curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" -H "Accept: application/vnd.github+json" "${API_BASE}${path}"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(res);
  }

  // Fallback: gh CLI
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (result.status !== 0) fail(`gh api ${path} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Downloads a GitHub Release asset to a local path.
 *
 * Uses `gh release download` (preferred) because it correctly handles
 * the GitHub → S3 redirect for private repo assets — curl with a Bearer
 * token breaks on the S3 redirect since S3 rejects the auth header.
 *
 * Falls back to the GitHub API asset endpoint with --no-location + manual
 * redirect handling if gh CLI is unavailable.
 */
function downloadAsset(repo, releaseTag, assetId, assetName, destPath) {
  // Download via GitHub API asset endpoint using the numeric asset ID.
  // Must use the asset ID URL (not browser_download_url) to avoid the
  // broken Bearer-token-on-S3-redirect issue with private repos.
  if (!GITHUB_TOKEN) {
    throw new Error(
      'GITHUB_TOKEN is not set. Cannot download release assets from private repos.'
    );
  }
  const assetApiUrl = `${API_BASE}/repos/${repo}/releases/assets/${assetId}`;
  const cmd = [
    'curl', '-fsSL',
    '-H', `Authorization: Bearer ${GITHUB_TOKEN}`,
    '-H', 'Accept: application/octet-stream',
    '-L', assetApiUrl,
    '-o', destPath,
  ];
  const result = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`curl download failed for ${repo} asset ${assetName}`);
  }
}

/**
 * Fetches the release info for an app.
 * - version "latest": fetches the latest release
 * - version "v1.2.3": fetches that specific tag
 */
function fetchRelease(repo, version) {
  const path = version === 'latest'
    ? `/repos/${repo}/releases/latest`
    : `/repos/${repo}/releases/tags/${version}`;
  return ghApi(path);
}

/**
 * Finds the dist.tar.gz asset in a release.
 */
function findDistAsset(release, repo) {
  const asset = release.assets?.find(a => a.name === 'dist.tar.gz');
  if (!asset) {
    fail(
      `No 'dist.tar.gz' asset found in release '${release.tag_name}' of ${repo}.\n` +
      `Available assets: ${release.assets?.map(a => a.name).join(', ') || 'none'}\n` +
      `See contract/HEADLESS_RULES.md for how to publish release artifacts.`
    );
  }
  return asset;
}

// ── Single-page bundles ───────────────────────────────────────────────────────

/**
 * Downloads a single-page bundle and expands it into one app per doc.
 *
 * Same release/asset logic as a packaged app — the difference is what the
 * tarball contains: a bundle.json manifest plus one directory per doc, each of
 * which is mirrored into apps/{slug}/ exactly like a packaged app's dist.
 * See contract/SINGLE_PAGE.md.
 *
 * @returns {Promise<Array>} expanded app entries, each tagged with its bundleKey
 */
async function fetchBundle(app) {
  const { repo, version = 'latest' } = app;
  const key = bundleKey(app);

  console.log(`\n\x1b[1m[${key}]\x1b[0m Fetching single-page bundle from ${repo}@${version}`);

  const workDir = join(TMP_DIR, '_bundles', bundleDirName(key));
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  log(`Fetching release info (${version})…`);
  let release;
  try {
    release = fetchRelease(repo, version);
  } catch (err) {
    fail(`Could not fetch release for ${repo}@${version}: ${err.message}`);
  }
  log(`Found release: ${release.tag_name} (${release.published_at?.slice(0, 10)})`);

  const asset   = findDistAsset(release, repo);
  const tarPath = join(workDir, 'dist.tar.gz');
  log(`Downloading ${asset.name} (${(asset.size / 1024).toFixed(1)} KB)…`);
  downloadAsset(repo, release.tag_name, asset.id, asset.name, tarPath);

  log('Extracting…');
  execSync(`tar -xzf "${tarPath}" -C "${workDir}"`, { stdio: 'pipe' });

  const bundleRoot = findBundleRoot(workDir);
  if (!bundleRoot) {
    fail(
      `${key}: the release artifact has no ${BUNDLE_MANIFEST} at its root.\n` +
      `     A "single-page" entry expects a bundle published by ` +
      `AbsaOSS/knowledge-base/actions/publish-docs — see contract/SINGLE_PAGE.md.`,
    );
  }

  const docs = expandBundle(app, readBundleManifest(bundleRoot, key), bundleRoot);

  for (const doc of docs) {
    const appsSlugDir = join(APPS_DIR, doc.slug);
    if (existsSync(appsSlugDir)) rmSync(appsSlugDir, { recursive: true });
    execSync(`cp -r "${doc.docDir}" "${appsSlugDir}"`, { stdio: 'pipe' });

    const html = readFileSync(join(appsSlugDir, doc.entryPoint), 'utf8');
    if (!html.includes('data-mp-headless="true"')) {
      warn(`${doc.slug}: ${doc.entryPoint} is missing data-mp-headless="true" — see contract/HEADLESS_RULES.md.`);
    }
    ok(`${doc.slug} ready (single-page doc, ${release.tag_name})`);
  }

  return docs.map(doc => ({
    ...toRegistryEntry(doc),
    bundleKey:  key,
    releaseTag: release.tag_name,
    releasedAt: release.published_at,
  }));
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Downloads and extracts all app artifacts.
 * Returns enriched app metadata array (apps.json entries + release info).
 *
 * @param {Array} apps - Contents of apps.json
 * @returns {Promise<Array>} - Enriched app list with { ...app, distDir, releaseTag, releasedAt }
 */
export async function fetchApps(apps) {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(APPS_DIR, { recursive: true });

  const enriched = [];

  for (const app of apps) {
    // A single-page entry is one artifact holding many docs — it expands into
    // several enriched entries rather than one.
    if (isSinglePage(app)) {
      enriched.push(...await fetchBundle(app));
      continue;
    }

    const { repo, slug, version = 'latest' } = app;

    console.log(`\n\x1b[1m[${slug}]\x1b[0m Fetching from ${repo}@${version}`);

    const appDir = join(TMP_DIR, slug);
    if (existsSync(appDir)) {
      rmSync(appDir, { recursive: true });
    }
    mkdirSync(appDir, { recursive: true });

    // 1. Fetch release metadata
    log(`Fetching release info (${version})…`);
    let release;
    try {
      release = fetchRelease(repo, version);
    } catch (err) {
      fail(`Could not fetch release for ${repo}@${version}: ${err.message}`);
    }
    log(`Found release: ${release.tag_name} (${release.published_at?.slice(0, 10)})`);

    // 2. Find the dist.tar.gz asset
    const asset = findDistAsset(release, repo);
    const tarPath = join(appDir, 'dist.tar.gz');

    // 3. Download artifact
    log(`Downloading ${asset.name} (${(asset.size / 1024).toFixed(1)} KB)…`);
    downloadAsset(repo, release.tag_name, asset.id, asset.name, tarPath);

    // 4. Extract
    log('Extracting…');
    execSync(`tar -xzf "${tarPath}" -C "${appDir}"`, { stdio: 'pipe' });

    // Determine extracted dist location (may be dist/ or root-level files)
    const distDir = existsSync(join(appDir, 'dist'))
      ? join(appDir, 'dist')
      : appDir;

    // 4b. Mirror into apps/{slug}/ for the Vite dev server and build pipeline
    const appsSlugDir = join(APPS_DIR, slug);
    if (existsSync(appsSlugDir)) rmSync(appsSlugDir, { recursive: true });
    execSync(`cp -r "${distDir}" "${appsSlugDir}"`, { stdio: 'pipe' });
    // 5. Validate marketplace.json exists (in the tarball root, not dist/)
    const manifestInTar  = join(appDir, 'marketplace.json');

    // Also copy marketplace.json if present alongside the dist dir
    if (existsSync(manifestInTar)) {
      const { copyFileSync } = await import('fs');
      copyFileSync(manifestInTar, join(appsSlugDir, 'marketplace.json'));
    }
    log(`Synced to apps/${slug}/`);
    const manifestInDist = join(distDir, 'marketplace.json');
    let manifest = null;

    if (existsSync(manifestInTar)) {
      manifest = JSON.parse(readFileSync(manifestInTar, 'utf8'));
    } else if (existsSync(manifestInDist)) {
      manifest = JSON.parse(readFileSync(manifestInDist, 'utf8'));
    } else {
      warn(`No marketplace.json found in artifact for ${slug}. Using apps.json metadata.`);
    }

    // 6. Validate headless HTML (spot-check index.html)
    const indexHtml = join(distDir, app.entryPoint || 'index.html');
    if (existsSync(indexHtml)) {
      const html = readFileSync(indexHtml, 'utf8');
      if (!html.includes('data-mp-headless="true"')) {
        warn(
          `${slug}/index.html is missing data-mp-headless="true" on <html>.\n` +
          `     See contract/HEADLESS_RULES.md — ensure the app is built with --headless.`
        );
      }
    } else {
      warn(`${slug}: entryPoint '${app.entryPoint || 'index.html'}' not found in artifact.`);
    }

    ok(`${slug} ready (${release.tag_name})`);

    enriched.push({
      ...app,
      // Merge manifest fields if present (manifest wins over apps.json for display fields)
      name:        manifest?.name        ?? app.name,
      description: manifest?.description ?? app.description,
      icon:        manifest?.icon        ?? app.icon,
      tags:        manifest?.tags        ?? app.tags ?? [],
      entryPoint:  manifest?.entryPoint  ?? app.entryPoint ?? 'index.html',
      pages:       manifest?.pages       ?? null,
      // Build metadata
      distDir,
      releaseTag:  release.tag_name,
      releasedAt:  release.published_at,
    });
  }

  return enriched;
}
