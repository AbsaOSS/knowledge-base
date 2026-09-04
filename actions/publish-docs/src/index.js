/**
 * index.js — entry point of the publish-docs build step.
 *
 * Takes a repository's already-built headless site and turns it into the
 * release artifact: read the manifest, verify the HTML, stage one directory per
 * app, pack. Uploading happens in the action's next step, which reads the
 * artifact path from this script's outputs.
 *
 * This action never builds the site. Doc repos use mkdocs, Starlight, Jekyll and
 * hand-rolled scripts; the contract is about the output, not the toolchain.
 *
 * Env:
 *   KB_MANIFEST   path to kb-docs.json                  (default: <workspace>/kb-docs.json)
 *   KB_DIST       built output                          (default: <workspace>/dist)
 *   KB_WORKSPACE  repo checkout root                    (default: cwd)
 *   KB_STAGE      staging directory                     (default: <workspace>/.kb-publish)
 *   KB_ARTIFACT   destination tarball                   (default: <workspace>/kb-docs.tar.gz)
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ASSET_NAME, PublishError, readManifestFile, writeManifest } from '../../lib/manifest.js';
import { packArtifact } from '../../lib/pack.js';
import { run, setOutput, summary } from '../../lib/runner.js';
import { verifyApps } from '../../lib/verify-html.js';

/**
 * Resolves an app's built output inside the `dist` input.
 *
 * One app is the common case, and then `dist` *is* that app's directory — a repo
 * publishing a single site should not have to invent a subdirectory named after
 * its own slug. With several apps, `dist` holds one subdirectory per slug.
 */
function appDirResolver(manifest, distDir) {
  if (manifest.apps.length === 1) return () => distDir;
  return (slug) => join(distDir, slug);
}

function main() {
  const workspace = resolve(process.env.KB_WORKSPACE || process.cwd());
  const manifestPath = resolve(process.env.KB_MANIFEST || join(workspace, 'kb-docs.json'));
  const distDir = resolve(process.env.KB_DIST || join(workspace, 'dist'));
  const stageDir = resolve(process.env.KB_STAGE || join(workspace, '.kb-publish'));
  const artifact = resolve(process.env.KB_ARTIFACT || join(workspace, ASSET_NAME));

  if (!existsSync(distDir)) {
    throw new PublishError(
      `The built output directory does not exist: ${distDir}\n` +
      `Run your site build before this step, and set the "dist" input if it writes somewhere else.`,
    );
  }

  const manifest = readManifestFile(manifestPath);
  const appDirFor = appDirResolver(manifest, distDir);

  for (const app of manifest.apps) {
    const dir = appDirFor(app.slug);
    if (!existsSync(dir)) {
      throw new PublishError(
        `${app.slug}: no built output at ${dir}.\n` +
        (manifest.apps.length === 1
          ? `The manifest declares one app, so "dist" must be that app's built directory.`
          : `The manifest declares ${manifest.apps.length} apps, so "dist" must hold one subdirectory per slug.`),
      );
    }
  }

  verifyApps(manifest, appDirFor);

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  for (const app of manifest.apps) {
    cpSync(appDirFor(app.slug), join(stageDir, app.slug), { recursive: true });
  }
  writeManifest(stageDir, manifest);

  const slugs = manifest.apps.map((a) => a.slug);
  packArtifact(stageDir, artifact, slugs);

  console.log(`Packed ${slugs.length} app(s) into ${artifact}:`);
  for (const app of manifest.apps) console.log(`  • ${app.slug.padEnd(24)} ${app.name}`);

  summary(
    `### Knowledge base docs published\n\n` +
    manifest.apps.map((a) => `- \`${a.slug}\` — ${a.name}`).join('\n') + '\n',
  );

  setOutput('artifact', artifact);
  setOutput('slugs', slugs.join(','));
  setOutput('count', String(slugs.length));
}

run(main);
