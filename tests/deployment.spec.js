// deployment.spec.js — the guards a production build relies on.
//
// A deployment is assembled from someone else's registry by a workflow nobody
// watches. The two things that matter are that a registry which cannot produce a
// correct deployment fails loudly, and that the build says what it was made
// from. Both are asserted here against the real orchestrator.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(ROOT, 'scripts', 'build-vite.js');

/**
 * The provenance the harness's own build wrote, read once at load time.
 *
 * Deliberately captured before any test in this file runs: the orchestrator
 * always writes to dist/, so reading it later would race with anything else in
 * the suite that builds.
 */
const provenance = JSON.parse(readFileSync(join(ROOT, 'dist', 'kb-build.json'), 'utf8'));

/**
 * Runs the orchestrator against a throwaway registry and expects it to refuse.
 *
 * Every case here is rejected during registry validation — before anything is
 * fetched, staged or written — which is both the point of the check and the
 * reason this is safe to run against the shared dist/. A registry that got as
 * far as producing output would overwrite the build the rest of the suite reads.
 */
function rejects(entries, { strict = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-registry-'));
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify(entries, null, 2));

  try {
    const stdout = execFileSync(process.execPath, [BUILD, '--headless'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, KB_REGISTRY: file, KB_STRICT: String(strict) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('strict mode', () => {
  test('rejects a prebuilt entry — a path on a disk is not a deployment', () => {
    const { ok, output } = rejects([{ prebuilt: 'tests/fixtures/docs-example.kb-docs.tar.gz' }]);
    expect(ok).toBe(false);
    expect(output).toContain('"prebuilt" is not allowed in a strict build');
    expect(output).toContain('contract/DEPLOYMENT.md');
  });

  test('rejects a localPath entry', () => {
    const { ok, output } = rejects([{ localPath: '../somewhere' }]);
    expect(ok).toBe(false);
    expect(output).toContain('"localPath" is not allowed in a strict build');
  });

  test('rejects an optional entry — shipping without an app is not a warning', () => {
    const { ok, output } = rejects([
      { prebuilt: 'tests/fixtures/single-page-bundle', optional: true },
    ]);
    expect(ok).toBe(false);
    expect(output).toMatch(/not allowed in a strict build/);
  });

  test('rejects an empty registry', () => {
    const { ok, output } = rejects([]);
    expect(ok).toBe(false);
    expect(output).toContain('will not publish an empty knowledge base');
  });

  test('the same entries are fine when strict is off', () => {
    // Strictness is a deployment concern only: the development registry, built
    // entirely from `prebuilt` fixtures, must keep working. The harness's own
    // build is the evidence — it is non-strict, every source is a prebuilt path,
    // and every other spec in this suite reads what it produced.
    expect(provenance.strict).toBe(false);
    expect(provenance.sources.length).toBeGreaterThan(0);
    for (const source of provenance.sources) expect(source.version).toBe('prebuilt');
  });

  test('an iframe entry is not subject to the released-artifact rules', () => {
    // A documented stopgap (#10) with no artifact to pin, so the rules about
    // released artifacts cannot apply to it. Proven by getting *past* strict
    // validation: the run fails later, on the deliberately malformed version of
    // the entry beside it, and never on the iframe.
    const { ok, output } = rejects([
      {
        type: 'iframe',
        slug: 'external-docs',
        url: 'https://example.com/docs',
        name: 'External Docs',
        description: 'Externally hosted documentation.',
      },
      { repo: 'AbsaOSS/nothing-here', version: 'not a tag' },
    ]);
    expect(ok).toBe(false);
    expect(output).toContain('not valid in a git tag');
    expect(output, 'the iframe entry must survive strict validation')
      .not.toContain('not allowed in a strict build');
  });
});

test.describe('build provenance', () => {
  // Written by the build the Playwright webServer already ran.
  const file = join(ROOT, 'dist', 'kb-build.json');

  test('is written next to the built site', () => {
    expect(existsSync(file), 'dist/kb-build.json missing').toBe(true);
  });

  test('records which source produced each app', () => {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));

    expect(manifest.registry).toBeTruthy();
    expect(Date.parse(manifest.builtAt)).not.toBeNaN();

    // Every app in the deployment traces back to a source and a version. Once an
    // image is pushed this is the only thing that can answer "which release
    // produced this page" — the registry cannot, because `latest` has moved.
    const bySlug = new Map();
    for (const source of manifest.sources) {
      expect(source.source, 'a source entry with no origin').toBeTruthy();
      expect(source.version, `${source.source} has no version`).toBeTruthy();
      for (const slug of source.slugs) bySlug.set(slug, source);
    }

    for (const slug of ['user-guide', 'guide-mirror', 'platform-overview', 'release-process']) {
      expect(bySlug.has(slug), `${slug} is not attributed to any source`).toBe(true);
    }

    // Two apps from one artifact are attributed to that one artifact, not
    // invented as separate sources.
    expect(bySlug.get('user-guide').source).toBe(bySlug.get('guide-mirror').source);
  });

  test('records iframe entries separately, since they have no artifact', () => {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    expect(manifest.iframes.map((i) => i.slug)).toContain('external-docs');
  });
});
