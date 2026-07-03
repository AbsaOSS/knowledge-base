// src/utils/apps.js
// File-system helpers for enumerating sub-app pages.
// Importable from both getStaticPaths and server-side scripts.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';

/** Recursively collect every .html file under a directory. */
export function collectHtmlFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectHtmlFiles(full));
    else if (entry.endsWith('.html')) results.push(full);
  }
  return results;
}

/**
 * Returns all sub-app page descriptors for use in getStaticPaths.
 * Each descriptor contains the route path, the absolute file path,
 * the app slug, and the effective headless flag.
 *
 * @param {string} cwd          - project root (process.cwd())
 * @param {boolean} headless    - global headless default
 */
export function getAppPages(cwd, headless) {
  const appsDir  = join(cwd, 'apps');
  const appsJson = join(cwd, 'apps.json');

  const apps = existsSync(appsJson)
    ? JSON.parse(readFileSync(appsJson, 'utf-8'))
    : [];

  const pages = [];

  for (const app of apps) {
    const appDir      = join(appsDir, app.slug);
    const appHeadless = app.headless ?? headless;

    if (app.type === 'iframe') {
      // iFrame onboarding mode: no artifact on disk — emit a single route that
      // renders a full-viewport <iframe> for the external URL. See issue #10.
      pages.push({
        routePath:   app.slug,
        file:        null,
        slug:        app.slug,
        fileRelDir:  '',
        appHeadless,
        apps,
        title:       app.name ?? app.slug,
        section:     null,
        iframe:      true,
        url:         app.url,
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
          apps,
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
          apps,
          title:       null,
          section:     null,
        });
      }
    }
  }

  return pages;
}
