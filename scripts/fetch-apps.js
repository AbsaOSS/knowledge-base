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

import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { copyDir, extractTarball } from './artifacts.js';
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

/** `owner/name`, the only shape a registry `repo` may take. */
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Git tag characters we are willing to put in a URL path. */
const VERSION_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Rejects registry values that must never reach a URL or a subprocess argument.
 *
 * apps.json is a reviewed file, but it is also the one file an onboarding PR
 * edits, so its values are validated rather than trusted.
 */
function assertSafeTarget(repo, version, label) {
  if (typeof repo !== 'string' || !REPO_RE.test(repo)) {
    fail(`${label}: "repo" must look like "owner/name", got ${JSON.stringify(repo)}.`);
  }
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    fail(`${label}: "version" ${JSON.stringify(version)} contains characters that are not valid in a git tag.`);
  }
}

/**
 * Makes a GitHub API request. Uses GITHUB_TOKEN when available, otherwise
 * delegates to `gh api` CLI so developers don't need to set tokens locally.
 *
 * The token is passed as a request header, never as part of a command line:
 * a shell string would put it in the process argv (readable by any local
 * process, and echoed back in the error execSync throws on a failed request).
 */
async function ghApi(path) {
  if (GITHUB_TOKEN) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) fail(`GitHub API request failed: ${res.status} ${res.statusText} — ${path}`);
    return res.json();
  }

  // Fallback: gh CLI. spawnSync takes an argv array, so nothing is shell-parsed.
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8' });
  if (result.status !== 0) fail(`gh api ${path} failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

/**
 * Downloads a GitHub Release asset to a local path.
 *
 * Uses the API asset endpoint with the numeric asset ID rather than
 * browser_download_url: for a private repo the latter redirects to S3, which
 * rejects requests carrying an Authorization header. `fetch` follows the
 * redirect and drops the header across origins, which is exactly what is wanted.
 */
async function downloadAsset(repo, assetId, assetName, destPath) {
  if (!GITHUB_TOKEN) {
    throw new Error(
      'GITHUB_TOKEN is not set. Cannot download release assets from private repos.'
    );
  }
  const res = await fetch(`${API_BASE}/repos/${repo}/releases/assets/${assetId}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed for ${repo} asset ${assetName}: ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
}

/**
 * Fetches the release info for an app.
 * - version "latest": fetches the latest release
 * - version "v1.2.3": fetches that specific tag
 */
async function fetchRelease(repo, version) {
  const path = version === 'latest'
    ? `/repos/${repo}/releases/latest`
    : `/repos/${repo}/releases/tags/${encodeURIComponent(version)}`;
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
  assertSafeTarget(repo, version, key);

  console.log(`\n\x1b[1m[${key}]\x1b[0m Fetching single-page bundle from ${repo}@${version}`);

  const workDir = join(TMP_DIR, '_bundles', bundleDirName(key));
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  log(`Fetching release info (${version})…`);
  let release;
  try {
    release = await fetchRelease(repo, version);
  } catch (err) {
    fail(`Could not fetch release for ${repo}@${version}: ${err.message}`);
  }
  log(`Found release: ${release.tag_name} (${release.published_at?.slice(0, 10)})`);

  const asset   = findDistAsset(release, repo);
  const tarPath = join(workDir, 'dist.tar.gz');
  log(`Downloading ${asset.name} (${(asset.size / 1024).toFixed(1)} KB)…`);
  await downloadAsset(repo, asset.id, asset.name, tarPath);

  log('Extracting…');
  extractTarball(tarPath, workDir, `${key}@${release.tag_name}`);

  const bundleRoot = findBundleRoot(workDir);
  if (!bundleRoot) {
    fail(
      `${key}: the release artifact has no ${BUNDLE_MANIFEST} at its root.\n` +
      `     A "single-page" entry expects a bundle published by ` +
      `AbsaOSS/knowledge-base/actions/publish-single-page-docs — see contract/SINGLE_PAGE.md.`,
    );
  }

  const docs = expandBundle(app, readBundleManifest(bundleRoot, key), bundleRoot);

  for (const doc of docs) {
    const appsSlugDir = join(APPS_DIR, doc.slug);
    if (existsSync(appsSlugDir)) rmSync(appsSlugDir, { recursive: true });
    copyDir(doc.docDir, appsSlugDir);

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
    assertSafeTarget(repo, version, slug);

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
      release = await fetchRelease(repo, version);
    } catch (err) {
      fail(`Could not fetch release for ${repo}@${version}: ${err.message}`);
    }
    log(`Found release: ${release.tag_name} (${release.published_at?.slice(0, 10)})`);

    // 2. Find the dist.tar.gz asset
    const asset = findDistAsset(release, repo);
    const tarPath = join(appDir, 'dist.tar.gz');

    // 3. Download artifact
    log(`Downloading ${asset.name} (${(asset.size / 1024).toFixed(1)} KB)…`);
    await downloadAsset(repo, asset.id, asset.name, tarPath);

    // 4. Extract — validated against traversal and symlink members first.
    log('Extracting…');
    extractTarball(tarPath, appDir, `${slug}@${release.tag_name}`);

    // Determine extracted dist location (may be dist/ or root-level files)
    const distDir = existsSync(join(appDir, 'dist'))
      ? join(appDir, 'dist')
      : appDir;

    // 4b. Mirror into apps/{slug}/ for the Vite dev server and build pipeline
    const appsSlugDir = join(APPS_DIR, slug);
    if (existsSync(appsSlugDir)) rmSync(appsSlugDir, { recursive: true });
    copyDir(distDir, appsSlugDir);
    // 5. Validate marketplace.json exists (in the tarball root, not dist/)
    const manifestInTar  = join(appDir, 'marketplace.json');

    // Also copy marketplace.json if present alongside the dist dir
    if (existsSync(manifestInTar)) {
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
