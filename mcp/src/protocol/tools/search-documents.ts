import type { McpServer } from '@modelcontextprotocol/server';
import type { KnowledgeBase, SearchResult } from '../../knowledge-base.ts';
import { searchInput, searchOutput } from '../schemas.ts';
import { READ_ONLY, toolError, toolResult } from '../tool-result.ts';
import type { ResourceLink } from '../tool-result.ts';

const linkFor = (result: SearchResult): ResourceLink => ({
  type: 'resource_link',
  uri: result.uri,
  name: result.uri.slice('kb://'.length),
  title: result.title,
  description: result.excerpt,
  mimeType: 'text/markdown',
});

export function registerSearchDocuments(server: McpServer, kb: KnowledgeBase): void {
  server.registerTool(
    'search_documents',
    {
      title: 'Search knowledge base documentation',
      description:
        'Search documentation by keyword. Input: query plus optional app, tag, limit, and cursor. Output: ranked matches, excerpts, kb:// URIs, and a nextCursor. Example: {"query":"release process","limit":8}. Read a match with read_document.',
      inputSchema: searchInput,
      outputSchema: searchOutput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const value = await kb.search(params);
        return toolResult(value, value.results.map(linkFor));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
