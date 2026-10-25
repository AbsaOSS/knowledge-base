/**
 * tests/navigation.spec.js
 *
 * Unit tests for src/utils/navigation.js — the masthead's model of the apps and
 * their manifest pages. The fixture artifact exercises one manifest; these are
 * the shapes it does not: interleaved sections, an unordered manifest, an entry
 * point the manifest leaves out, nested page paths.
 */

import { test, expect } from '@playwright/test';
import { buildNavigation, navigationFor, pageRelDir, routeHref } from '../src/utils/navigation.js';

const BASE = '/knowledge-base';

test.describe('pageRelDir / routeHref', () => {
  test('a page routes to its directory, the app root for a file at the top', () => {
    expect(pageRelDir('index.html')).toBe('');
    expect(pageRelDir('docs/index.html')).toBe('docs');
    expect(pageRelDir('docs\\guide\\index.html')).toBe('docs/guide');
    expect(routeHref(BASE, 'app')).toBe('/knowledge-base/app/');
    expect(routeHref(BASE, 'app', 'docs/guide')).toBe('/knowledge-base/app/docs/guide/');
  });
});

test.describe('buildNavigation', () => {
  test('apps keep registry order; an app without a manifest has no pages', () => {
    const nav = buildNavigation([
      { slug: 'zeta', name: 'Zeta', icon: 'cube' },
      { slug: 'alpha', name: 'Alpha' },
      { slug: 'ext', name: 'External', type: 'iframe', url: 'https://example.com' },
    ], BASE);
    expect(nav.map((a) => a.slug)).toEqual(['zeta', 'alpha', 'ext']);
    expect(nav.map((a) => a.href)).toEqual(['/knowledge-base/zeta/', '/knowledge-base/alpha/', '/knowledge-base/ext/']);
    expect(nav.every((a) => a.items.length === 0)).toBe(true);
    expect(nav[1].icon).toBe('book-open');
  });

  test('pages sort by order; a page without a section is an entry, a section one entry of its pages', () => {
    const [app] = buildNavigation([{
      slug: 'app', name: 'App',
      pages: [
        { title: 'Deploy',   path: 'ops/deploy/index.html', order: 4, section: 'Operations' },
        { title: 'Home',     path: 'index.html',            order: 0 },
        { title: 'Install',  path: 'start/index.html',      order: 1, section: 'Getting started' },
        { title: 'Monitor',  path: 'ops/monitor/index.html', order: 3, section: 'Operations' },
        { title: 'Tutorial', path: 'start/tour/index.html', order: 2, section: 'Getting started' },
        { title: 'FAQ',      path: 'faq/index.html',        order: 5 },
      ],
    }], BASE);
    expect(app.items).toEqual([
      { type: 'page', title: 'Home', href: '/knowledge-base/app/' },
      { type: 'section', title: 'Getting started', pages: [
        { title: 'Install',  href: '/knowledge-base/app/start/' },
        { title: 'Tutorial', href: '/knowledge-base/app/start/tour/' },
      ] },
      { type: 'section', title: 'Operations', pages: [
        { title: 'Monitor', href: '/knowledge-base/app/ops/monitor/' },
        { title: 'Deploy',  href: '/knowledge-base/app/ops/deploy/' },
      ] },
      { type: 'page', title: 'FAQ', href: '/knowledge-base/app/faq/' },
    ]);
  });

  test('a section keeps the place of its first page when the manifest interleaves', () => {
    const [app] = buildNavigation([{
      slug: 'app', name: 'App',
      pages: [
        { title: 'A', path: 'a/index.html', order: 0, section: 'S' },
        { title: 'B', path: 'b/index.html', order: 1 },
        { title: 'C', path: 'c/index.html', order: 2, section: 'S' },
      ],
    }], BASE);
    expect(app.items.map((i) => `${i.type}:${i.title}`)).toEqual(['section:S', 'page:B']);
    expect(app.items[0].pages.map((p) => p.title)).toEqual(['A', 'C']);
  });

  test('an entry point the manifest leaves out is reached through the app, not added', () => {
    const [app] = buildNavigation([{
      slug: 'app', name: 'App',
      pages: [{ title: 'Guide', path: 'guide/index.html', order: 0 }],
    }], BASE);
    expect(app.href).toBe('/knowledge-base/app/');
    expect(app.items).toEqual([{ type: 'page', title: 'Guide', href: '/knowledge-base/app/guide/' }]);
  });

  test('an iframe entry is a link even if it somehow carries pages', () => {
    const [app] = buildNavigation([{ slug: 'x', name: 'X', type: 'iframe', url: 'https://e.com', pages: [{ title: 'P', path: 'p/index.html', order: 0 }] }], BASE);
    expect(app.items).toEqual([]);
  });
});

test.describe('navigationFor', () => {
  test('memoises per registry array and base', () => {
    const apps = [{ slug: 'a', name: 'A' }];
    expect(navigationFor(apps, BASE)).toBe(navigationFor(apps, BASE));
    expect(navigationFor(apps, '/other')[0].href).toBe('/other/a/');
    expect(navigationFor([...apps], BASE)).not.toBe(navigationFor(apps, BASE));
  });
});
