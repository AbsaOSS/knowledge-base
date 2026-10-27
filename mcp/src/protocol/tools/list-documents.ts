import type { McpServer } from '@modelcontextprotocol/server';
import type { KnowledgeBase } from '../../knowledge-base.ts';
import { listInput, listOutput } from '../schemas.ts';
import { READ_ONLY, toolError, toolResult } from '../tool-result.ts';

export function registerListDocuments(server: McpServer, kb: KnowledgeBase): void {
  server.registerTool(
    'list_documents',
    {
      title: 'List knowledge base documents',
      description:
        'List documentation in canonical route order. Input: optional app, tag, title, limit, and cursor. Output: document metadata and nextCursor. Example: {"app":"service-accounts","limit":50}.',
      inputSchema: listInput,
      outputSchema: listOutput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        return toolResult(await kb.list(params));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
