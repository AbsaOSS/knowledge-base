// Wiring: which adapters back the facade. The one place that names concrete backends,
// shared by the server entry point and the tests.
import type { SearchIndex } from '../search-index/schema.ts';
import { SearchIndexRepository } from './adapters/memory/search-index-repository.ts';
import { LexicalSearch } from './adapters/memory/lexical-search.ts';
import { KnowledgeBase } from './knowledge-base.ts';
import type { KnowledgeBaseOptions } from './knowledge-base.ts';

/** A knowledge base served entirely from the search index file, in memory. */
export function memoryKnowledgeBase(searchIndex: SearchIndex, options: KnowledgeBaseOptions = {}): KnowledgeBase {
  return new KnowledgeBase(new SearchIndexRepository(searchIndex), new LexicalSearch(searchIndex), options);
}

/** The server version: the generator's, e.g. `knowledge-base@1.0.0` → `1.0.0`. */
export const versionOf = (searchIndex: SearchIndex): string => searchIndex.generator.split('@')[1] ?? '1.0.0';
