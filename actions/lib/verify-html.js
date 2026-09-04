/**
 * verify-html.js — checks built HTML against contract/HEADLESS_RULES.md.
 *
 * This runs in the publishing repo, at publish time, which is the only moment
 * anyone can act on it. The knowledge base build warns about the same things,
 * but by then the artifact is already released and the person who can fix it has
 * moved on.
 *
 * Every problem is collected and reported together, each naming the file.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PublishError } from './manifest.js';

/** The marker the knowledge base looks for on `<html>`. */
export const HEADLESS_MARKER = 'data-kb-headless="true"';
/** Its pre-v1 spelling, worth naming explicitly when we see it. */
const LEGACY_MARKER = 'data-mp-headless';

/** Every .html file under a directory. Symlinks are skipped. */
export function htmlFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith('.html')) acc.push(full);
  }
  return acc;
}

/**
 * Verifies one app's built output.
 *
 * @param {string} appDir - directory that becomes `<slug>/` in the artifact
 * @param {object} app    - the app's manifest entry
 * @returns {{errors: string[], warnings: string[]}}
 */
export function verifyApp(appDir, app) {
  const errors = [];
  const warnings = [];
  const rel = (file) => relative(appDir, file).replace(/\\/g, '/');

  const entryPoint = app.entryPoint ?? 'index.html';
  if (!existsSync(join(appDir, entryPoint))) {
    errors.push(
      `${app.slug}: entryPoint "${entryPoint}" does not exist in the built output. ` +
      `Check the action's "dist" input points at your build directory.`,
    );
  }

  for (const page of app.pages ?? []) {
    if (!existsSync(join(appDir, page.path))) {
      errors.push(
        `${app.slug}: pages entry "${page.title}" points at "${page.path}", which is not in the built output.`,
      );
    }
  }

  const files = htmlFiles(appDir);
  if (files.length === 0) {
    errors.push(`${app.slug}: the built output contains no HTML at all.`);
    return { errors, warnings };
  }

  for (const file of files) {
    const html = readFileSync(file, 'utf8');
    const where = `${app.slug}/${rel(file)}`;

    if (!html.includes(HEADLESS_MARKER)) {
      errors.push(
        html.includes(LEGACY_MARKER)
          ? `${where}: carries ${LEGACY_MARKER}, the pre-v1 marker. Emit ${HEADLESS_MARKER} instead.`
          : `${where}: missing ${HEADLESS_MARKER} on <html>. Build with your headless flag.`,
      );
    }

    if (/<base\b/i.test(html)) {
      errors.push(`${where}: contains a <base> element, which re-resolves every URL once the page is re-hosted.`);
    }

    // Root-relative URLs are authored for the app's own site root, but the app
    // is served from /knowledge-base/{slug}/, so they 404 there. //host and
    // /favicon are left alone, matching the knowledge base's own rewrite.
    const absolute = [...html.matchAll(/\b(?:href|src|action|poster)="(\/[^/"][^"]*)"/g)]
      .map((m) => m[1])
      .filter((url) => !url.startsWith('/favicon'));
    if (absolute.length > 0) {
      errors.push(
        `${where}: ${absolute.length} root-relative URL(s), e.g. "${absolute[0]}". ` +
        `Paths must be relative — the app is mounted under /knowledge-base/{slug}/.`,
      );
    }

    // Not fatal: the knowledge base hoists inline scripts so it can serve
    // script-src 'self'. The repo should still know they are there.
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
      .filter((m) => m[1].trim() !== '');
    if (inline.length > 0) {
      warnings.push(
        `${where}: ${inline.length} inline <script> block(s). The knowledge base will hoist them into ` +
        `files so it can serve script-src 'self'; ship them as files to keep control of that.`,
      );
    }
  }

  return { errors, warnings };
}

/**
 * Verifies every app in a manifest and throws once if any failed.
 *
 * @param {(slug: string) => string} appDirFor - resolves an app's built output
 */
export function verifyApps(manifest, appDirFor) {
  const errors = [];
  const warnings = [];
  for (const app of manifest.apps) {
    const result = verifyApp(appDirFor(app.slug), app);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }

  for (const warning of warnings) process.stdout.write(`::warning::${warning}\n`);

  if (errors.length > 0) {
    throw new PublishError(
      `The built output does not satisfy contract/HEADLESS_RULES.md:\n` +
      errors.map((e) => `  • ${e}`).join('\n'),
    );
  }
  return { warnings };
}
