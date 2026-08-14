// src/utils/apps.js
// File-system helpers for enumerating sub-app pages.
// Importable from both getStaticPaths and server-side scripts.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { isSinglePage, readExpansionMap, resolveRegistry } from './single-page.js';

/**
 * Cached result of loadRegistry, keyed by cwd and invalidated by mtime.
 *
 * getAppPages calls loadRegistry, and Astro may call getStaticPaths more than
 * once per build, so the registry was being re-read, re-parsed and re-resolved
 * for no new information. Keying on the mtimes rather than on cwd alone keeps
 * `astro dev` honest: editing apps.json is still picked up on the next request,
 * at the cost of two statSync calls instead of two full reads and parses.
 */
let registryCache = null;

/** Modification stamp of the two files the registry is built from. */
function registryStamp(cwd) {
  const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
  return `${mtime(join(cwd, 'apps.json'))}:${mtime(join(cwd, 'apps', '.single-page.json'))}`;
}

/**
 * Reads the effective app registry.
 *
 * apps.json is the source of truth, except for `type: "single-page"` entries:
 * those point at a bundle whose docs are only known after the build fetched it,
 * so each one is replaced by the apps it expanded into (see single-page.js).
 *
 * @param {string} cwd - project root (process.cwd())
 */
export function loadRegistry(cwd) {
  const stamp = registryStamp(cwd);
  if (registryCache && registryCache.cwd === cwd && registryCache.stamp === stamp) {
    return registryCache.apps;
  }

  const appsJson = join(cwd, 'apps.json');
  const registry = existsSync(appsJson)
    ? JSON.parse(readFileSync(appsJson, 'utf-8'))
    : [];

  const apps = resolveRegistry(registry, readExpansionMap(cwd), (msg) => {
    process.stderr.write(`  \x1b[33m⚠\x1b[0m  ${msg}\n`);
  });

  registryCache = { cwd, stamp, apps };
  return apps;
}

/** Recursively collect every .html file under a directory. Symlinks are skipped. */
export function collectHtmlFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  // withFileTypes: the type comes from the directory read that already happened,
  // rather than a statSync per entry, and a symlink is reported as one instead
  // of as its target.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...collectHtmlFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) results.push(full);
  }
  return results;
}

/**
 * Returns all sub-app page descriptors for use in getStaticPaths.
 * Each descriptor contains the route path, the absolute file path,
 * the app slug, and the effective headless flag.
 *
 * Note what is *not* in a descriptor: the registry. getStaticPaths returns one
 * entry per HTML file and every one of them used to carry the whole resolved
 * registry, so the route table grew with apps × pages × apps. (It cost build
 * memory, not output bytes — these props are never serialised into the static
 * HTML.) Only the current app's card is needed: the masthead names it and the
 * catchall titles the page with it.
 *
 * @param {string} cwd          - project root (process.cwd())
 * @param {boolean} headless    - global headless default
 */
export function getAppPages(cwd, headless) {
  const appsDir = join(cwd, 'apps');
  const apps    = loadRegistry(cwd);

  const pages = [];

  for (const app of apps) {
    const appDir      = join(appsDir, app.slug);
    const appHeadless = app.headless ?? headless;
    /** The only registry data a sub-app page needs. */
    const card        = { slug: app.slug, name: app.name ?? app.slug, icon: app.icon };

    if (app.type === 'iframe') {
      // iFrame onboarding mode: no artifact on disk — emit a single route that
      // renders a full-viewport <iframe> for the external URL. See issue #10.
      pages.push({
        routePath:   app.slug,
        file:        null,
        slug:        app.slug,
        fileRelDir:  '',
        appHeadless,
        app:         card,
        title:       app.name ?? app.slug,
        section:     null,
        iframe:      true,
        url:         app.url,
      });
      continue;
    }

    if (isSinglePage(app)) {
      // Single-page onboarding (issue #35): the artifact holds exactly one
      // document per app, so there is nothing to crawl — emit its single route
      // and let the catchall render it in the centred reading column.
      pages.push({
        routePath:   app.slug,
        file:        join(appDir, app.entryPoint ?? 'index.html'),
        slug:        app.slug,
        fileRelDir:  '',
        appHeadless,
        app:         card,
        title:       app.name ?? app.slug,
        section:     null,
        singlePage:  true,
      });
      continue;
    }

    if (Array.isArray(app.pages) && app.pages.length > 0) {
      // Manifest-driven routing: use the pages array from marketplace.json
      for (const page of app.pages) {
        const file        = join(appDir, page.path);
        const fileRelDir  = dirname(page.path).replace(/\\/g, '/').replace(/^\.$/, '');
        const routeParts  = [app.slug];
        if (fileRelDir) routeParts.push(fileRelDir);

        pages.push({
          routePath:   routeParts.join('/'),
          file,
          slug:        app.slug,
          fileRelDir,
          appHeadless,
          app:         card,
          title:       page.title,
          section:     page.section ?? null,
        });
      }
    } else {
      // Fallback: crawl the filesystem for all HTML files
      for (const file of collectHtmlFiles(appDir)) {
        const fileRelDir = relative(appDir, dirname(file)).replace(/\\/g, '/');
        const routeParts = [app.slug];
        if (fileRelDir) routeParts.push(fileRelDir);

        pages.push({
          routePath:   routeParts.join('/'),
          file,
          slug:        app.slug,
          fileRelDir,
          appHeadless,
          app:         card,
          title:       null,
          section:     null,
        });
      }
    }
  }

  return pages;
}
