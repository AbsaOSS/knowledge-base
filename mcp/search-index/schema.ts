// The search index file format: written by the build (mcp/build/), read by the server
// (mcp/src/). The one definition both sides share, so it must stay free of parse5,
// the filesystem and the Astro utilities.

export const SEARCH_INDEX_SCHEMA_VERSION = 1;

export interface IndexedApp {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  kind?: 'artifact' | 'iframe';
  url?: string | null;
  sourceVersion?: string | null;
}

export interface IndexedSection {
  heading: string;
  /** The heading's id, when it is a safe fragment identifier. */
  anchor: string | null;
  level: number;
  /** Character offsets into the document text, `start` inclusive and `end` exclusive. */
  start: number;
  end: number;
}

export interface IndexedDocument {
  /** `kb://<app>/<path>`, unique within the search index. */
  uri: string;
  app: string;
  /** Site-absolute route, e.g. `/knowledge-base/<app>/<path>/`. */
  route: string;
  title: string;
  description: string;
  tags: string[];
  section?: string | null;
  mimeType: string;
  sourceVersion: string | null;
  sha256: string;
  size: number;
  truncated: boolean;
  /** Markdown-like plain text extracted from the page at build time. */
  text: string;
  sections: IndexedSection[];
}

export interface SearchIndex {
  schemaVersion: typeof SEARCH_INDEX_SCHEMA_VERSION;
  generator: string;
  indexedAt: string;
  pathPrefix?: string;
  /** Hash over every document; cursors are bound to it. */
  contentHash: string;
  apps: IndexedApp[];
  documents: IndexedDocument[];
}

const DOCUMENT_STRING_FIELDS = ['uri', 'app', 'route', 'title', 'description', 'mimeType', 'sha256', 'text'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function validateSection(section: unknown, text: string, uri: string): void {
  if (
    !isRecord(section) ||
    typeof section.heading !== 'string' ||
    !Number.isInteger(section.start) ||
    !Number.isInteger(section.end)
  ) {
    throw new Error(`Invalid MCP search index: bad section in ${uri}`);
  }
  const start = section.start as number;
  const end = section.end as number;
  if (start < 0 || start >= end || end > text.length)
    throw new Error(`Invalid MCP search index: bad section in ${uri}`);
}

/** Check the structure the server relies on; returns the search index, typed, or throws. */
export function validateSearchIndex(searchIndex: unknown): SearchIndex {
  if (
    !isRecord(searchIndex) ||
    searchIndex.schemaVersion !== SEARCH_INDEX_SCHEMA_VERSION ||
    !Array.isArray(searchIndex.apps) ||
    !Array.isArray(searchIndex.documents) ||
    typeof searchIndex.contentHash !== 'string'
  ) {
    throw new Error('Invalid MCP search index: schemaVersion, apps, documents and contentHash are required');
  }
  for (const app of searchIndex.apps as unknown[]) {
    if (!isRecord(app) || typeof app.slug !== 'string' || typeof app.name !== 'string') {
      throw new Error('Invalid MCP search index: invalid app');
    }
  }
  const seen = new Set<string>();
  for (const document of searchIndex.documents as unknown[]) {
    const fields = isRecord(document) ? document : {};
    for (const key of DOCUMENT_STRING_FIELDS) {
      if (typeof fields[key] !== 'string') throw new Error(`Invalid MCP search index: document ${key}`);
    }
    const uri = fields.uri as string;
    if (seen.has(uri)) throw new Error(`Invalid MCP search index: duplicate URI ${uri}`);
    seen.add(uri);
    if (!Array.isArray(fields.sections)) throw new Error('Invalid MCP search index: sections');
    for (const section of fields.sections as unknown[]) validateSection(section, fields.text as string, uri);
  }
  return searchIndex as unknown as SearchIndex;
}
