/**
 * fetch-apps.js
 *
 * Downloads the kb-docs.tar.gz release asset for a registry entry that names a
 * `repo`. Requires either:
 *   - GITHUB_TOKEN env variable, OR
 *   - `gh` CLI authenticated (used as fallback for the API, not for downloads)
 *
 * This module only *obtains* an artifact. Reading its manifest, validating it
 * and installing its apps into apps/{slug}/ is the same code for every source
 * and lives in scripts/build-vite.js — see contract/ARTIFACT.md. Keeping the two
 * apart is what stopped the GitHub path and the prebuilt path from drifting the
 * way they used to.
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_NAME, SIZE_LIMIT, SIZE_WARN } from '../src/utils/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
/** Where downloaded artifacts land before they are staged. */
const DOWNLOAD_DIR = join(ROOT, 'tmp', 'downloads');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API_BASE     = 'https://api.github.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg)  { process.stdout.write(`  \x1b[36m→\x1b[0m ${msg}\n`); }
function warn(msg) { process.stderr.write(`  \x1b[33m⚠\x1b[0m  ${msg}\n`); }
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
 * Fetches the release info for an entry.
 * - version "latest": fetches the latest release
 * - version "v1.2.3": fetches that specific tag
 */
async function fetchRelease(repo, version) {
  const path = version === 'latest'
    ? `/repos/${repo}/releases/latest`
    : `/repos/${repo}/releases/tags/${encodeURIComponent(version)}`;
  return ghApi(path);
}

/** Finds the kb-docs.tar.gz asset in a release. */
function findArtifactAsset(release, repo) {
  const asset = release.assets?.find((a) => a.name === ARTIFACT_NAME);
  if (!asset) {
    const available = release.assets?.map((a) => a.name).join(', ') || 'none';
    const legacy = release.assets?.some((a) => a.name === 'dist.tar.gz');
    fail(
      `No '${ARTIFACT_NAME}' asset in release '${release.tag_name}' of ${repo}.\n` +
      `     Available assets: ${available}\n` +
      (legacy
        ? `     This release carries 'dist.tar.gz', the pre-v1 asset name. Republish it with a\n` +
          `     current AbsaOSS/knowledge-base publishing action.\n`
        : '') +
      `     See contract/ARTIFACT.md for what a release must carry.`,
    );
  }
  return asset;
}

/**
 * Enforces the artifact size budget from contract/ARTIFACT.md.
 *
 * Every registered artifact is downloaded on every deployment build, so an
 * oversized one is a cost the whole knowledge base pays rather than a private
 * matter for the publishing repo.
 */
export function checkArtifactSize(bytes, label) {
  if (bytes > SIZE_LIMIT) {
    fail(
      `${label}: the artifact is ${mb(bytes)} MB, over the ${mb(SIZE_LIMIT)} MB limit.\n` +
      `     See contract/ARTIFACT.md — the usual cause is uncompressed images or a vendored\n` +
      `     toolchain the built site does not need at runtime.`,
    );
  }
  if (bytes > SIZE_WARN) {
    warn(
      `${label}: the artifact is ${mb(bytes)} MB, over the ${mb(SIZE_WARN)} MB target. ` +
      `Every deployment build downloads it — see contract/ARTIFACT.md.`,
    );
  }
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Downloads one entry's release artifact.
 *
 * @param {object} app - an apps.json entry naming a `repo`
 * @returns {Promise<{tarPath: string, releaseTag: string, releasedAt: string}>}
 */
export async function downloadArtifact(app) {
  const { repo, version = 'latest' } = app;
  assertSafeTarget(repo, version, repo ?? '(unnamed entry)');

  const workDir = join(DOWNLOAD_DIR, repo.replace('/', '__'));
  if (existsSync(workDir)) rmSync(workDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  log(`Fetching release info for ${repo}@${version}…`);
  let release;
  try {
    release = await fetchRelease(repo, version);
  } catch (err) {
    fail(`Could not fetch release for ${repo}@${version}: ${err.message}`);
  }
  log(`Found release: ${release.tag_name} (${release.published_at?.slice(0, 10)})`);

  const asset   = findArtifactAsset(release, repo);
  const tarPath = join(workDir, ARTIFACT_NAME);

  checkArtifactSize(asset.size, `${repo}@${release.tag_name}`);
  log(`Downloading ${asset.name} (${mb(asset.size)} MB)…`);
  await downloadAsset(repo, asset.id, asset.name, tarPath);

  // The API reports a size; trust the bytes on disk over the metadata.
  checkArtifactSize(statSync(tarPath).size, `${repo}@${release.tag_name}`);

  return { tarPath, releaseTag: release.tag_name, releasedAt: release.published_at };
}
