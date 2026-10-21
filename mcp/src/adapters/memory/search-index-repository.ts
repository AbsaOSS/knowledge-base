// Documents served straight from the search index file the build generated.
import { readFile } from 'node:fs/promises';
import { validateSearchIndex } from '../../../search-index/schema.ts';
import type { SearchIndex } from '../../../search-index/schema.ts';
import type { App, IndexInfo, DocumentFilter, Page, PageRequest, StoredDocument } from '../../domain.ts';
import type { DocumentRepository } from '../../ports.ts';
import { fingerprint, paginate } from './cursor.ts';

export async function loadSearchIndex(file: string): Promise<SearchIndex> {
  return validateSearchIndex(JSON.parse(await readFile(file, 'utf8')));
}

const matches = (document: StoredDocument, { app, tag, title }: DocumentFilter): boolean =>
  (!app || document.app === app) &&
  (!tag || document.tags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) &&
  (!title || document.title.toLowerCase().includes(title.toLowerCase()));

/** Canonical document order: by app, then route. */
const byAppThenRoute = (a: StoredDocument, b: StoredDocument) =>
  a.app.localeCompare(b.app) || a.route.localeCompare(b.route);

export class SearchIndexRepository implements DocumentRepository {
  private readonly searchIndex: SearchIndex;
  /** Sorted here rather than trusted: the build sorts, but a search index is just a file. */
  private readonly documents: StoredDocument[];
  private readonly byUri: Map<string, StoredDocument>;
  private readonly bySlug: Map<string, App>;

  constructor(searchIndex: SearchIndex) {
    this.searchIndex = searchIndex;
    this.documents = [...searchIndex.documents].sort(byAppThenRoute);
    this.byUri = new Map(searchIndex.documents.map((document) => [document.uri, document]));
    this.bySlug = new Map(searchIndex.apps.map((app) => [app.slug, app]));
  }

  info(): IndexInfo {
    const { generator, indexedAt, contentHash } = this.searchIndex;
    return { generator, indexedAt, contentHash };
  }

  apps(): readonly App[] {
    return this.searchIndex.apps;
  }

  app(slug: string): App | undefined {
    return this.bySlug.get(slug);
  }

  async get(uri: string): Promise<StoredDocument | undefined> {
    return this.byUri.get(uri);
  }

  async list(filter: DocumentFilter, page: PageRequest): Promise<Page<StoredDocument>> {
    const items = this.documents.filter((document) => matches(document, filter));
    const print = fingerprint(
      `${this.searchIndex.contentHash}|${filter.app ?? ''}|${filter.tag ?? ''}|${filter.title ?? ''}`,
    );
    return paginate(items, page, print);
  }
}
