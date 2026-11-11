// Types the facade and every search backend share. Protocol-agnostic: nothing here knows
// about MCP, and nothing here knows how documents are stored or searched.
import type { IndexedApp, IndexedDocument } from '../search-index/schema.ts';

export type App = IndexedApp;
export type StoredDocument = IndexedDocument;

export interface PageRequest {
  /** Opaque, backend-issued; absent for the first page. */
  cursor?: string | undefined;
  limit: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export interface DocumentFilter {
  app?: string | undefined;
  /** Case-insensitive exact tag. */
  tag?: string | undefined;
  /** Case-insensitive title substring. */
  title?: string | undefined;
}

export interface SearchQuery {
  text: string;
  app?: string | undefined;
  tag?: string | undefined;
}

export interface SearchHit {
  document: StoredDocument;
  /** The section that best matches, when the document has sections. */
  section?: { heading: string; anchor: string | null };
  excerpt: string;
  score: number;
}

/** What the server says about the search index it serves. */
export interface IndexInfo {
  generator: string;
  indexedAt: string;
  /** Changes whenever any document does; cursors are bound to it. */
  contentHash: string;
}

/** Errors a caller can fix by changing its input; their message is safe to show. */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}

export class InvalidCursorError extends UserFacingError {
  override name = 'InvalidCursorError';
  constructor() {
    super('Invalid cursor');
  }
}

export class EmptyQueryError extends UserFacingError {
  override name = 'EmptyQueryError';
  constructor() {
    super('Query has no searchable terms');
  }
}

export class UnknownDocumentError extends UserFacingError {
  override name = 'UnknownDocumentError';
  readonly uri: string;
  constructor(uri: string) {
    super(`Unknown document URI: ${uri}. Use search_documents or list_documents to find valid URIs.`);
    this.uri = uri;
  }
}
