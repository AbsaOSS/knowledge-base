/**
 * tests/artifact-checks.spec.js
 *
 * The build runs the publish action's contract checker on every artifact it
 * installs (scripts/check-artifact.js). Two things keep that honest:
 *
 *   1. The build and the action parse with the same code at the same versions.
 *      check.js resolves htmlparser2/postcss from actions/node_modules when that
 *      tree is installed and from the root otherwise — CI's E2E job installs
 *      only the root — so the two package.json files must pin the same versions.
 *   2. The reporting contract: grouped warnings in an ordinary build, and a
 *      strict (production) build that refuses an artifact with an error finding.
 *
 * No browser and no build: the checker's rules themselves are pinned by
 * actions/lib/check.selftest.js.
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkApp, reportFindings, summarise } from '../scripts/check-artifact.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

/** A minimal app directory with the given files. */
function app(files) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-artifact-check-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const page = (html = 'data-kb-headless="true"', body = '') =>
  `<!doctype html><html ${html}><head><title>T</title></head><body><main>${body}</main></body></html>`;

const ENTRY = { slug: 'demo', entryPoint: 'index.html', pages: null };

test.describe('the build and the action parse the same way', () => {
  test('root package.json pins the parsers at the versions actions/package.json pins', () => {
    const root = pkg('package.json').dependencies;
    const actions = pkg('actions/package.json').dependencies;
    for (const name of ['htmlparser2', 'postcss']) {
      expect(actions[name], `actions/package.json must pin ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(root[name], `package.json must pin ${name} exactly as actions/ does`).toBe(actions[name]);
    }
  });
});

test.describe('reporting an artifact', () => {
  test('repeated findings are grouped by rule, with a count and the first example', () => {
    const dir = app({
      'index.html': page(undefined, '<script>a()</script>'),
      'guide/index.html': page(undefined, '<script>b()</script>'),
    });
    try {
      const lines = summarise(checkApp(dir, ENTRY));
      expect(lines).toHaveLength(1);
      expect(lines[0].id).toBe('KB-HTML-004');
      expect(lines[0].line).toMatch(/^KB-HTML-004 ×2, e\.g\. demo\/\S+\.html: 1 inline <script>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ordinary build warns about every finding, errors included, and carries on', () => {
    const dir = app({ 'index.html': page('lang="en"', '<button onclick="x()">x</button>') });
    try {
      const warned = [];
      const counts = reportFindings('owner/docs', checkApp(dir, ENTRY), { strict: false, warn: (m) => warned.push(m) });
      expect(counts).toEqual({ errors: 1, warnings: 1 });
      expect(warned.some((m) => /^owner\/docs: error KB-HTML-001 demo\/index\.html/.test(m)), warned.join('\n')).toBe(true);
      expect(warned.some((m) => /^owner\/docs: warning KB-HTML-005/.test(m)), warned.join('\n')).toBe(true);
      expect(warned.at(-1)).toMatch(/1 error\(s\), 1 warning\(s\) against contract\/RULES\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a strict build refuses an artifact with an error finding, naming the rule', () => {
    const dir = app({ 'index.html': page('data-mp-headless="true"') });
    try {
      expect(() => reportFindings('owner/docs', checkApp(dir, ENTRY), { strict: true, warn: () => {} }))
        .toThrow(/owner\/docs: the artifact breaks the knowledge base contract[\s\S]*KB-HTML-001 demo\/index\.html: carries data-mp-headless/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a strict build only warns about warnings, and a clean artifact says nothing', () => {
    const noisy = app({ 'index.html': page(undefined, '<script>a()</script>') });
    const clean = app({ 'index.html': page() });
    try {
      const warned = [];
      expect(reportFindings('owner/docs', checkApp(noisy, ENTRY), { strict: true, warn: (m) => warned.push(m) }))
        .toEqual({ errors: 0, warnings: 1 });
      expect(warned.length).toBeGreaterThan(0);

      const silent = [];
      expect(reportFindings('owner/docs', checkApp(clean, ENTRY), { strict: true, warn: (m) => silent.push(m) }))
        .toEqual({ errors: 0, warnings: 0 });
      expect(silent).toEqual([]);
    } finally {
      rmSync(noisy, { recursive: true, force: true });
      rmSync(clean, { recursive: true, force: true });
    }
  });
});
