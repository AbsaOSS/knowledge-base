import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getAppPages, loadRegistry } from '../src/utils/apps.js';
import { isIframe } from '../src/utils/registry.js';
import { PATH_PREFIX } from '../src/utils/config.js';
import { extractDocument } from './extract.js';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const uriFor = (routePath) => `kb://${routePath.split('/').map(encodeURIComponent).join('/')}`;
const routeFor = (routePath) => `/${PATH_PREFIX}/${routePath}/`;
const versionFor = (slug, provenance) => provenance?.[slug] ?? null;

export function buildCorpus({ root = process.cwd(), headless = false, versions = {}, now = new Date().toISOString(), warn = () => {} } = {}) {
  const registry = loadRegistry(root);
  const apps = registry.map((app) => ({ slug: app.slug, name: app.name, description: app.description, tags: app.tags ?? [], kind: isIframe(app) ? 'iframe' : 'artifact', url: isIframe(app) ? app.url : null, sourceVersion: versionFor(app.slug, versions) })).sort((a, b) => a.slug.localeCompare(b.slug));
  const appBySlug = new Map(apps.map((app) => [app.slug, app]));
  const candidates = getAppPages(root, headless).filter((page) => page.iframe || basename(page.file) !== '404.html');
  const byRoute = new Map();
  for (const page of candidates) {
    const prior = byRoute.get(page.routePath);
    if (!prior || basename(page.file ?? '') === 'index.html' || (basename(prior.file ?? '') !== 'index.html' && String(page.file).localeCompare(String(prior.file)) < 0)) {
      if (prior && basename(page.file ?? '') !== 'index.html') warn(`MCP route collision for ${page.routePath}; chose ${page.file}`);
      byRoute.set(page.routePath, page);
    }
  }
  const documents = [];
  for (const page of byRoute.values()) {
    const app = appBySlug.get(page.slug); if (!app) continue;
    let extracted;
    if (page.iframe) {
      const text = `# ${app.name}\n\n${app.description}\n\nExternal documentation: ${app.url}`;
      extracted = { title: app.name, description: app.description, text, sections: [], truncated: false };
    } else {
      const html = existsSync(page.file) ? readFileSync(page.file, 'utf8') : '';
      extracted = extractDocument(html, { fallbackTitle: app.name, pageTitle: page.title, description: app.description, warn });
      if (!extracted.text) { extracted.text = `# ${extracted.title || app.name}\n\n${extracted.description || app.description}`; warn(`MCP extraction empty for ${page.routePath}`); }
    }
    const text = extracted.text;
    documents.push({ uri: uriFor(page.routePath), app: page.slug, route: routeFor(page.routePath), title: extracted.title || app.name, description: extracted.description || app.description, tags: app.tags, section: page.section ?? null, mimeType: 'text/markdown', sourceVersion: app.sourceVersion, sha256: sha(text), size: Buffer.byteLength(text), truncated: extracted.truncated, text, sections: extracted.sections });
  }
  documents.sort((a, b) => a.app.localeCompare(b.app) || a.route.localeCompare(b.route));
  const seen = new Set(); for (const document of documents) { if (seen.has(document.uri)) throw new Error(`Duplicate MCP URI: ${document.uri}`); seen.add(document.uri); }
  const corpus = { schemaVersion: 1, generator: 'knowledge-base@1.0.0', indexedAt: now, pathPrefix: PATH_PREFIX, contentHash: sha(JSON.stringify(documents)), apps, documents };
  validateCorpus(corpus); return corpus;
}

export function validateCorpus(corpus) {
  if (!corpus || corpus.schemaVersion !== 1 || !Array.isArray(corpus.apps) || !Array.isArray(corpus.documents) || typeof corpus.contentHash !== 'string') throw new Error('Invalid MCP corpus: schemaVersion, apps, documents and contentHash are required');
  const seen = new Set();
  for (const app of corpus.apps) if (!app || typeof app.slug !== 'string' || typeof app.name !== 'string') throw new Error('Invalid MCP corpus: invalid app');
  for (const document of corpus.documents) {
    for (const key of ['uri', 'app', 'route', 'title', 'description', 'mimeType', 'sha256', 'text']) if (typeof document?.[key] !== 'string') throw new Error(`Invalid MCP corpus: document ${key}`);
    if (seen.has(document.uri)) throw new Error(`Invalid MCP corpus: duplicate URI ${document.uri}`); seen.add(document.uri);
    if (!Array.isArray(document.sections)) throw new Error('Invalid MCP corpus: sections');
    for (const section of document.sections) if (typeof section.heading !== 'string' || !Number.isInteger(section.start) || !Number.isInteger(section.end) || section.start < 0 || section.start >= section.end || section.end > document.text.length) throw new Error(`Invalid MCP corpus: bad section in ${document.uri}`);
  }
  return corpus;
}
export function writeCorpus(file, corpus) { validateCorpus(corpus); writeFileSync(file, JSON.stringify(corpus) + '\n'); }
