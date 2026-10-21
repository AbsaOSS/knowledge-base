// Builds the search index from the sub-app pages the Astro build rendered. Build time only.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getAppPages, loadRegistry } from '../../src/utils/apps.js';
import { isIframe } from '../../src/utils/registry.js';
import { PATH_PREFIX } from '../../src/utils/config.js';
import { SEARCH_INDEX_SCHEMA_VERSION, validateSearchIndex } from '../search-index/schema.ts';
import type { SearchIndex, IndexedApp, IndexedDocument } from '../search-index/schema.ts';
import { extractDocument } from './extract.ts';
import type { ExtractedDocument } from './extract.ts';

/** A registry entry as `loadRegistry()` returns it, after manifest expansion. */
interface RegistryApp {
  slug: string;
  name?: string;
  description?: string;
  tags?: string[];
  url?: string;
}

/** A page as `getAppPages()` enumerates it. */
interface AppPage {
  slug: string;
  routePath: string;
  file?: string;
  title?: string;
  section?: string;
  iframe?: boolean;
}

export interface BuildSearchIndexOptions {
  root?: string;
  headless?: boolean;
  /** Source version label per app slug (the release tag, or `prebuilt`/`local`). */
  versions?: Record<string, string>;
  now?: string;
  warn?: (message: string) => void;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const uriFor = (routePath: string) => `kb://${routePath.split('/').map(encodeURIComponent).join('/')}`;
const routeFor = (routePath: string) => `/${PATH_PREFIX}/${routePath}/`;
const isIndex = (page: AppPage) => basename(page.file ?? '') === 'index.html';

/** This tool's own name and version, not the project being indexed. */
function generator(): string {
  const file = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
  return `${pkg.name ?? 'knowledge-base'}@${pkg.version ?? '0.0.0'}`;
}

function toIndexedApp(app: RegistryApp, versions: Record<string, string>): IndexedApp {
  const iframe = isIframe(app);
  return {
    slug: app.slug,
    name: app.name ?? app.slug,
    description: app.description ?? '',
    tags: app.tags ?? [],
    kind: iframe ? 'iframe' : 'artifact',
    url: iframe ? (app.url ?? null) : null,
    sourceVersion: versions[app.slug] ?? null,
  };
}

/**
 * One page per route. Two files can claim a route (`foo.html` and `foo/index.html`):
 * index.html wins, otherwise the lexically first file, so the choice is deterministic.
 */
function pagesByRoute(pages: AppPage[], warn: (message: string) => void): AppPage[] {
  const byRoute = new Map<string, AppPage>();
  for (const page of pages) {
    const prior = byRoute.get(page.routePath);
    const wins =
      !prior || isIndex(page) || (!isIndex(prior) && String(page.file).localeCompare(String(prior.file)) < 0);
    if (!wins) continue;
    if (prior && !isIndex(page)) warn(`MCP route collision for ${page.routePath}; chose ${String(page.file)}`);
    byRoute.set(page.routePath, page);
  }
  return [...byRoute.values()];
}

function extractPage(page: AppPage, app: IndexedApp, warn: (message: string) => void): ExtractedDocument {
  if (page.iframe) {
    const text = [`# ${app.name}`, app.description, `External documentation: ${String(app.url)}`]
      .filter(Boolean)
      .join('\n\n');
    return { title: app.name, description: app.description, text, sections: [], truncated: false };
  }
  const html = page.file && existsSync(page.file) ? readFileSync(page.file, 'utf8') : '';
  const extracted = extractDocument(html, {
    fallbackTitle: app.name,
    pageTitle: page.title ?? '',
    description: app.description,
    warn,
  });
  if (!extracted.text) {
    extracted.text = [`# ${extracted.title || app.name}`, extracted.description || app.description]
      .filter(Boolean)
      .join('\n\n');
    warn(`MCP extraction empty for ${page.routePath}`);
  }
  return extracted;
}

export function buildSearchIndex(options: BuildSearchIndexOptions = {}): SearchIndex {
  const {
    root = process.cwd(),
    headless = false,
    versions = {},
    now = new Date().toISOString(),
    warn = () => undefined,
  } = options;

  const apps = (loadRegistry(root) as RegistryApp[])
    .map((app) => toIndexedApp(app, versions))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const appBySlug = new Map(apps.map((app) => [app.slug, app]));
  const pages = (getAppPages(root, headless) as AppPage[]).filter(
    (page) => page.iframe === true || basename(page.file ?? '') !== '404.html',
  );

  const documents: IndexedDocument[] = [];
  for (const page of pagesByRoute(pages, warn)) {
    const app = appBySlug.get(page.slug);
    if (!app) continue;
    const extracted = extractPage(page, app, warn);
    const { text } = extracted;
    documents.push({
      uri: uriFor(page.routePath),
      app: page.slug,
      route: routeFor(page.routePath),
      title: extracted.title || app.name,
      description: extracted.description || app.description,
      tags: app.tags,
      section: page.section ?? null,
      mimeType: 'text/markdown',
      sourceVersion: app.sourceVersion ?? null,
      sha256: sha256(text),
      size: Buffer.byteLength(text),
      truncated: extracted.truncated,
      text,
      sections: extracted.sections,
    });
  }
  documents.sort((a, b) => a.app.localeCompare(b.app) || a.route.localeCompare(b.route));

  const seen = new Set<string>();
  for (const document of documents) {
    if (seen.has(document.uri)) throw new Error(`Duplicate MCP URI: ${document.uri}`);
    seen.add(document.uri);
  }

  return validateSearchIndex({
    schemaVersion: SEARCH_INDEX_SCHEMA_VERSION,
    generator: generator(),
    indexedAt: now,
    pathPrefix: PATH_PREFIX,
    contentHash: sha256(JSON.stringify(documents)),
    apps,
    documents,
  });
}

export function writeSearchIndex(file: string, searchIndex: SearchIndex): void {
  validateSearchIndex(searchIndex);
  writeFileSync(file, JSON.stringify(searchIndex) + '\n');
}
