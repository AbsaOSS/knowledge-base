// The facade the protocol layer talks to. It turns backend results into the public shapes
// clients see (links, app names, bounded reads) and knows nothing about MCP; the backends
// behind it know nothing about clients.
import { UnknownDocumentError } from './domain.ts';
import type { App, IndexInfo, Page, StoredDocument } from './domain.ts';
import type { DocumentRepository, SearchBackend } from './ports.ts';

export const DEFAULT_SEARCH_LIMIT = 8;
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_READ_CHARS = 20_000;

export interface PublicDocument {
  uri: string;
  title: string;
  app: string;
  appName: string;
  route: string;
  /** Absolute link, when the server knows its public origin. */
  url?: string;
}

export interface SearchParams {
  query: string;
  app?: string | undefined;
  tag?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SearchResult extends PublicDocument {
  section?: { heading: string; anchor: string | null };
  excerpt: string;
  score: number;
}

export interface ListParams {
  app?: string | undefined;
  tag?: string | undefined;
  title?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListedDocument extends PublicDocument {
  description: string;
  tags: string[];
  mimeType: string;
  size: number;
}

export interface ReadParams {
  uri: string;
  offset?: number | undefined;
  maxChars?: number | undefined;
}

export interface DocumentSlice extends PublicDocument {
  mimeType: 'text/markdown';
  offset: number;
  totalChars: number;
  text: string;
  nextOffset?: number;
  truncated: boolean;
}

/** Provenance a client can use to cite or cache a document. */
export interface DocumentMetadata {
  app: string;
  appName: string;
  route: string;
  url?: string;
  tags: string[];
  sha256: string;
  sourceVersion: string | null;
  indexedAt: string;
}

export interface KnowledgeBaseOptions {
  /** `https://host` the site is served from; links are site-relative without it. */
  publicOrigin?: string | undefined;
}

const isHighSurrogate = (char: string | undefined) => char !== undefined && /[\uD800-\uDBFF]/.test(char);
const isLowSurrogate = (char: string | undefined) => char !== undefined && /[\uDC00-\uDFFF]/.test(char);

export class KnowledgeBase {
  private readonly documents: DocumentRepository;
  private readonly searchBackend: SearchBackend;
  private readonly publicOrigin: string | undefined;

  constructor(documents: DocumentRepository, searchBackend: SearchBackend, options: KnowledgeBaseOptions = {}) {
    this.documents = documents;
    this.searchBackend = searchBackend;
    this.publicOrigin = options.publicOrigin;
  }

  info(): IndexInfo {
    return this.documents.info();
  }

  apps(): readonly App[] {
    return this.documents.apps();
  }

  /** Absolute when the public origin is known, else the site-relative route. */
  link(document: StoredDocument): string {
    return this.publicOrigin ? new URL(document.route, this.publicOrigin).toString() : document.route;
  }

  appName(document: StoredDocument): string {
    return this.documents.app(document.app)?.name ?? document.app;
  }

  async search(
    params: SearchParams,
  ): Promise<{ query: string; total: number; results: SearchResult[]; nextCursor?: string }> {
    const page = await this.searchBackend.search(
      { text: params.query, app: params.app, tag: params.tag },
      { cursor: params.cursor, limit: params.limit ?? DEFAULT_SEARCH_LIMIT },
    );
    const results = page.items.map(({ document, section, excerpt, score }) => ({
      ...this.publicDocument(document),
      ...(section ? { section } : {}),
      excerpt,
      score,
    }));
    return { query: params.query, total: page.total, results, ...this.next(page) };
  }

  async list(params: ListParams = {}): Promise<{ total: number; documents: ListedDocument[]; nextCursor?: string }> {
    const page = await this.documents.list(
      { app: params.app, tag: params.tag, title: params.title },
      { cursor: params.cursor, limit: params.limit ?? DEFAULT_LIST_LIMIT },
    );
    const documents = page.items.map((document) => ({
      ...this.publicDocument(document),
      description: document.description,
      tags: document.tags,
      mimeType: document.mimeType,
      size: document.size,
    }));
    return { total: page.total, documents, ...this.next(page) };
  }

  /** Every document in canonical order, one page at a time (MCP resources/list). */
  async browse(cursor: string | undefined, limit: number): Promise<Page<StoredDocument>> {
    return this.documents.list({}, { cursor, limit });
  }

  async get(uri: string): Promise<StoredDocument | undefined> {
    return this.documents.get(uri);
  }

  /** A bounded slice of a document's text that never splits a surrogate pair. */
  async read({ uri, offset = 0, maxChars = DEFAULT_READ_CHARS }: ReadParams): Promise<DocumentSlice> {
    const document = await this.documents.get(uri);
    if (!document) throw new UnknownDocumentError(uri);
    const { text } = document;
    let end = Math.min(text.length, offset + maxChars);
    if (end < text.length && isHighSurrogate(text[end - 1]) && isLowSurrogate(text[end])) end -= 1;
    const nextOffset = end < text.length ? end : undefined;
    return {
      ...this.publicDocument(document),
      mimeType: 'text/markdown',
      offset,
      totalChars: text.length,
      text: text.slice(offset, end),
      ...(nextOffset ? { nextOffset } : {}),
      truncated: Boolean(nextOffset),
    };
  }

  metadata(document: StoredDocument): DocumentMetadata {
    return {
      app: document.app,
      appName: this.appName(document),
      route: document.route,
      ...this.url(document),
      tags: document.tags,
      sha256: document.sha256,
      sourceVersion: document.sourceVersion,
      indexedAt: this.info().indexedAt,
    };
  }

  private publicDocument(document: StoredDocument): PublicDocument {
    return {
      uri: document.uri,
      title: document.title,
      app: document.app,
      appName: this.appName(document),
      route: document.route,
      ...this.url(document),
    };
  }

  private url(document: StoredDocument): { url?: string } {
    return this.publicOrigin ? { url: new URL(document.route, this.publicOrigin).toString() } : {};
  }

  private next(page: { nextCursor?: string }): { nextCursor?: string } {
    return page.nextCursor ? { nextCursor: page.nextCursor } : {};
  }
}
