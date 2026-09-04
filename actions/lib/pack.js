/**
 * pack.js — packs a staging directory as the release asset.
 *
 * Deterministic on purpose: same input, same bytes. `--sort=name` fixes member
 * order, and a fixed mtime and uid/gid keep the runner's clock and account out
 * of the archive. Without that, republishing an unchanged doc set produces a
 * different asset every time, and nobody can tell a real change from a rebuild.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { MANIFEST, PublishError } from './manifest.js';

/** Fixed timestamp for every archive member. Arbitrary, but stable. */
const EPOCH = '2020-01-01 00:00:00Z';

/** Artifact size budget from contract/ARTIFACT.md. */
const SIZE_WARN  = 20 * 1024 * 1024;
const SIZE_LIMIT = 100 * 1024 * 1024;

/**
 * Packs `stageDir` into `outPath`.
 *
 * Members are named explicitly rather than packing `.`, so anything that found
 * its way into the staging directory without being part of the artifact is left
 * out rather than shipped.
 *
 * @param {string} stageDir - holds kb-docs.json plus one directory per app
 * @param {string} outPath  - destination kb-docs.tar.gz
 * @param {string[]} slugs  - the app directories to include
 */
export function packArtifact(stageDir, outPath, slugs) {
  mkdirSync(dirname(outPath), { recursive: true });
  rmSync(outPath, { force: true });

  const present = new Set(readdirSync(stageDir));
  const members = [MANIFEST, ...slugs];
  for (const member of members) {
    if (!present.has(member)) {
      throw new PublishError(`Cannot pack: "${member}" is missing from the staging directory.`);
    }
  }

  execFileSync('tar', [
    '--force-local',
    '--sort=name',
    `--mtime=${EPOCH}`,
    '--owner=0', '--group=0', '--numeric-owner',
    '-czf', basename(outPath),
    '-C', stageDir,
    ...members,
  ], { cwd: dirname(outPath), stdio: 'pipe' });

  checkSize(outPath);
  return outPath;
}

/**
 * Enforces the shared size budget.
 *
 * Every registered artifact is downloaded on every deployment build, so an
 * oversized one is a cost the whole knowledge base pays.
 */
function checkSize(outPath) {
  const bytes = statSync(outPath).size;
  const mb = (n) => (n / 1024 / 1024).toFixed(1);

  if (bytes > SIZE_LIMIT) {
    throw new PublishError(
      `The packed artifact is ${mb(bytes)} MB, over the ${mb(SIZE_LIMIT)} MB limit ` +
      `(which is also GitHub's per-asset release limit).\n` +
      `The usual cause is uncompressed images or a vendored toolchain the built site does not ` +
      `need at runtime. See contract/ARTIFACT.md.`,
    );
  }
  if (bytes > SIZE_WARN) {
    process.stdout.write(
      `::warning::The packed artifact is ${mb(bytes)} MB, over the ${mb(SIZE_WARN)} MB target. ` +
      `Every knowledge base build downloads it — see contract/ARTIFACT.md.\n`,
    );
  }
}
