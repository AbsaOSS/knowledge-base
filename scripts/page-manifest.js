// Writes dist/_kb/pages.json: every documentation page the build published, with
// the app it belongs to. It is the whole interface between this build and
// consumers that do not run Node, such as the MCP server's indexer
// (mcp-server/): they read this file and the HTML under dist/, never the
// registry or the staged artifacts. Its shape is scripts/page-manifest.schema.json.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { getAppPages, loadRegistry } from '../src/utils/apps.js';
import { PATH_PREFIX } from '../src/utils/config.js';
import { isIframe } from '../src/utils/registry.js';

export const PAGE_MANIFEST_VERSION = 1;
export const PAGE_MANIFEST_FILE = join('_kb', 'pages.json');

const isIndexFile = (page) => basename(page.file ?? '') === 'index.html';

/**
 * Several source files can share a route: a crawled `foo.html` lives at its
 * directory's route, like the `index.html` beside it. index.html wins, else the
 * lexically first file, so the choice does not depend on directory order.
 */
function onePagePerRoute(pages, warn) {
  const byRoute = new Map();
  for (const page of pages) {
    const prior = byRoute.get(page.routePath);
    const wins = !prior || isIndexFile(page) || (!isIndexFile(prior) && String(page.file) < String(prior.file));
    if (prior && wins && !isIndexFile(page)) warn(`Pages ${prior.file} and ${page.file} share route ${page.routePath}`);
    if (wins) byRoute.set(page.routePath, page);
  }
  return [...byRoute.values()];
}

function toApp(app, versions) {
  const iframe = isIframe(app);
  return {
    slug: app.slug,
    name: app.name ?? app.slug,
    description: app.description ?? '',
    tags: app.tags ?? [],
    kind: iframe ? 'iframe' : 'artifact',
    url: iframe ? app.url : null,
    sourceVersion: versions.get(app.slug) ?? null,
  };
}

/**
 * Describe the pages under dist/. Call after `astro build`: a page whose HTML
 * was not published is a build error, not something to describe.
 *
 * @param {{ root: string, headless: boolean, provenance: { label: string, slugs: string[] }[], warn?: (message: string) => void }} options
 */
export function buildPageManifest({ root, headless, provenance, warn = () => {} }) {
  const versions = new Map(provenance.flatMap(({ label, slugs }) => slugs.map((slug) => [slug, label])));
  const apps = loadRegistry(root).map((app) => toApp(app, versions));
  const published = getAppPages(root, headless).filter((page) => page.iframe || basename(page.file) !== '404.html');

  const pages = onePagePerRoute(published, warn).map((page) => {
    const file = `${page.routePath}/index.html`;
    if (!existsSync(join(root, 'dist', file))) throw new Error(`Page manifest: dist/${file} was not built`);
    return {
      app: page.slug,
      route: `/${PATH_PREFIX}/${page.routePath}/`,
      file,
      title: page.title ?? null,
      section: page.section ?? null,
    };
  });
  pages.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

  return { schemaVersion: PAGE_MANIFEST_VERSION, pathPrefix: PATH_PREFIX, apps, pages };
}

/** Build the page manifest and write it to dist/_kb/pages.json; returns it. */
export function writePageManifest(options) {
  const manifest = buildPageManifest(options);
  const file = join(options.root, 'dist', PAGE_MANIFEST_FILE);
  mkdirSync(join(options.root, 'dist', '_kb'), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
