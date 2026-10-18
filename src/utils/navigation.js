// src/utils/navigation.js
//
// The masthead's navigation model: every app in the effective registry and,
// for an app whose kb-docs.json lists `pages`, those pages — ordered by
// `order`, a `section` gathering its pages into one entry. Built from the same
// resolved registry the routes come from, so a page a publisher adds to its
// manifest appears in the menu with no change here.
//
// The masthead shows one app's entries at a time — the app being viewed — so
// the bar stays the same length however many apps the knowledge base holds.
//
// The model is computed once per registry, not per page: getStaticPaths emits
// one entry per HTML file, and handing every one of them a copy of the whole
// registry is what made the route table grow with apps × pages × apps.
// Astro renders the masthead per page from this shared value instead.

import { posix } from 'node:path';
import { isIframe } from './registry.js';

/**
 * The route directory of a manifest page, relative to its app: '' for a file at
 * the app root, 'docs/guide' for docs/guide/index.html. The catchall route and
 * the menu both use it, so a menu link cannot point somewhere no page was built.
 *
 * @param {string} path - page path relative to the app directory
 */
export function pageRelDir(path) {
  // Separators first: the platform dirname only splits on '\' on Windows, so
  // the same path would route differently depending on the build host.
  return posix.dirname(path.replace(/\\/g, '/')).replace(/^\.$/, '');
}

/** Absolute URL of an app-relative route directory. Always ends in '/'. */
export function routeHref(base, slug, relDir = '') {
  return `${base}/${slug}/${relDir ? `${relDir}/` : ''}`;
}

/**
 * Turns already-ordered pages into menu entries: a page without a section is
 * an entry of its own, and a section is one entry holding its pages, placed
 * where its first page falls. A manifest that interleaves the two keeps its
 * reading order as far as grouping allows.
 */
function toItems(pages) {
  const items = [];
  const sections = new Map();
  for (const page of pages) {
    const link = { title: page.title, href: page.href };
    if (!page.section) {
      items.push({ type: 'page', ...link });
      continue;
    }
    let section = sections.get(page.section);
    if (!section) {
      section = { type: 'section', title: page.section, pages: [] };
      sections.set(page.section, section);
      items.push(section);
    }
    section.pages.push(link);
  }
  return items;
}

/** @typedef {{ title: string, href: string }} NavLink */
/** @typedef {{ type: 'page', title: string, href: string } | { type: 'section', title: string, pages: NavLink[] }} NavItem */
/** @typedef {{ slug: string, name: string, icon: string, href: string, items: NavItem[] }} NavApp */

/**
 * Builds the navigation model from a resolved registry (see loadRegistry).
 *
 * @param {any[]} apps  - effective registry entries
 * @param {string} base - URL base, e.g. '/knowledge-base'
 * @returns {NavApp[]} one entry per app, in registry order; `items` is empty for an app
 *          with no `pages` manifest (crawled, single-page or iframe). The app
 *          root is always reachable through `href`, so an entry point the
 *          manifest leaves out is not added to `items`.
 */
export function buildNavigation(apps, base) {
  return apps.map((app) => {
    const href = routeHref(base, app.slug);
    const entry = { slug: app.slug, name: app.name ?? app.slug, icon: app.icon || 'book-open', href, items: [] };
    if (isIframe(app) || !Array.isArray(app.pages) || app.pages.length === 0) return entry;

    const ordered = [...app.pages].sort((a, b) => a.order - b.order);
    entry.items = toItems(ordered.map((page) => ({
      title:   page.title,
      section: page.section ?? null,
      href:    routeHref(base, app.slug, pageRelDir(page.path)),
    })));
    return entry;
  });
}

const cache = new WeakMap();

/**
 * buildNavigation, memoised on the registry array loadRegistry caches.
 *
 * @param {any[]} apps
 * @param {string} base
 * @returns {NavApp[]}
 */
export function navigationFor(apps, base) {
  let byBase = cache.get(apps);
  if (!byBase) cache.set(apps, (byBase = new Map()));
  if (!byBase.has(base)) byBase.set(base, buildNavigation(apps, base));
  return byBase.get(base);
}
