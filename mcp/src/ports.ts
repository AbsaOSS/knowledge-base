// The contracts a storage or search backend implements. The facade (knowledge-base.ts)
// depends on these only; adapters live in ./adapters/<backend>/.
//
// Every method is async, though the in-memory adapters never wait: a network-bound
// backend (OpenSearch) must fit the same shape. Cursors are opaque and owned by the
// adapter that issued them — an offset for the memory adapter, search_after for OpenSearch.
import type {
  App,
  IndexInfo,
  DocumentFilter,
  Page,
  PageRequest,
  SearchHit,
  SearchQuery,
  StoredDocument,
} from './domain.ts';

export interface DocumentRepository {
  info(): IndexInfo;
  /** Every app, sorted by slug. */
  apps(): readonly App[];
  app(slug: string): App | undefined;
  get(uri: string): Promise<StoredDocument | undefined>;
  /** Documents matching `filter`, in canonical (app, route) order. Throws InvalidCursorError. */
  list(filter: DocumentFilter, page: PageRequest): Promise<Page<StoredDocument>>;
}

export interface SearchBackend {
  /**
   * Ranked matches, best first; an empty page when nothing matches. Throws EmptyQueryError
   * when the query has no words at all, and InvalidCursorError.
   */
  search(query: SearchQuery, page: PageRequest): Promise<Page<SearchHit>>;
}
