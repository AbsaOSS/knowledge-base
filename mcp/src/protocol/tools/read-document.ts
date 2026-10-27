import type { McpServer } from '@modelcontextprotocol/server';
import type { KnowledgeBase } from '../../knowledge-base.ts';
import { readInput, readOutput } from '../schemas.ts';
import { READ_ONLY, toolError, toolResult } from '../tool-result.ts';

export function registerReadDocument(server: McpServer, kb: KnowledgeBase): void {
  server.registerTool(
    'read_document',
    {
      title: 'Read knowledge base document',
      description:
        'Read one bounded documentation slice. Input: kb:// URI, optional character offset, and maxChars. Output: markdown text, totalChars, truncation state, and nextOffset. Example: {"uri":"kb://service-accounts/password-rotation","maxChars":20000}.',
      inputSchema: readInput,
      outputSchema: readOutput,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        return toolResult(await kb.read(params));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
