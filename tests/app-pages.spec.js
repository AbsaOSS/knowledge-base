import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAppPages } from '../src/utils/apps.js';
import { EXPANSION_FILE } from '../src/utils/registry.js';

function withProject(app, fn) {
  const root = mkdtempSync(join(tmpdir(), 'kb-app-pages-'));
  try {
    const appDir = join(root, 'apps', app.slug);
    mkdirSync(join(appDir, 'docs'), { recursive: true });
    writeFileSync(join(root, 'apps.json'), JSON.stringify([{ prebuilt: 'fixture' }]));
    writeFileSync(join(root, EXPANSION_FILE), JSON.stringify({ fixture: [app] }));
    writeFileSync(join(appDir, 'index.html'), '<html><head><title>Home</title></head><body>Home</body></html>');
    writeFileSync(join(appDir, 'docs', 'index.html'), '<html><head><title>Docs</title></head><body>Docs</body></html>');
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('manifest-driven apps still route their entry point when pages omit it', () => {
  withProject({
    slug: 'user-guide',
    name: 'User Guide',
    icon: 'book-open',
    entryPoint: 'index.html',
    pages: [{ title: 'Overview', path: 'docs/index.html', order: 1, section: null }],
  }, (root) => {
    const pages = getAppPages(root, true);
    expect(pages.map((page) => page.routePath)).toEqual(['user-guide', 'user-guide/docs']);
  });
});

test('manifest-driven apps do not duplicate entry point routes when pages include it', () => {
  withProject({
    slug: 'user-guide',
    name: 'User Guide',
    icon: 'book-open',
    entryPoint: 'index.html',
    pages: [
      { title: 'Home', path: 'index.html', order: 0, section: null },
      { title: 'Overview', path: 'docs/index.html', order: 1, section: null },
    ],
  }, (root) => {
    const pages = getAppPages(root, true);
    expect(pages.map((page) => page.routePath)).toEqual(['user-guide', 'user-guide/docs']);
  });
});
