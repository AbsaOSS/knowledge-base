import { SearchIndexRepository } from '../mcp/src/adapters/memory/search-index-repository.ts';
import { LexicalSearch } from '../mcp/src/adapters/memory/lexical-search.ts';
import { describeBackendContract } from './support/backend-contract.js';

describeBackendContract('memory', async (searchIndex) => ({
  documents: new SearchIndexRepository(searchIndex),
  search: new LexicalSearch(searchIndex),
}));
