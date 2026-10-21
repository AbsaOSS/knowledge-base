// Every document as a `kb://` resource: a cursor-paginated list and bounded reads.
import type { McpServer } from '@modelcontextprotocol/server';
import type { StoredDocument } from '../domain.ts';
import type { KnowledgeBase } from '../knowledge-base.ts';

/** `_meta` namespace for the provenance attached to each resource. */
const META_KEY = 'io.github.absaoss/knowledge-base';
/** JSON-RPC error code the MCP spec assigns to an unknown resource. */
const RESOURCE_NOT_FOUND = -32002;
/** Characters a resources/read returns, header included; read_document pages beyond it. */
const MAX_RESOURCE_CHARS = 100_000;

export interface ResourceOptions {
  pageSize: number;
}

const nameFor = (document: StoredDocument) => document.uri.slice('kb://'.length);

/** Title, app, link and version ahead of the text, so a bare read is still citable. */
function readableText(kb: KnowledgeBase, document: StoredDocument): string {
  const header =
    `Title: ${document.title}\n` +
    `App: ${kb.appName(document)} (${document.app})\n` +
    `Link: ${kb.link(document)}\n` +
    `Source version: ${String(document.sourceVersion)}\n---\n`;
  // read_document offsets count document characters only, so the header comes off the cut.
  const shown = Math.max(0, MAX_RESOURCE_CHARS - header.length);
  if (document.text.length <= shown) return header + document.text;
  return (
    `${header}${document.text.slice(0, shown)}\n\n` +
    `[truncated: ${document.text.length} document chars; continue with read_document {uri, offset: ${shown}}]`
  );
}

export function registerResources(server: McpServer, kb: KnowledgeBase, { pageSize }: ResourceOptions): void {
  server.server.setRequestHandler('resources/list', async (request) => {
    const page = await kb.browse(request.params?.cursor, pageSize);
    const resources = page.items.map((document) => ({
      uri: document.uri,
      name: nameFor(document),
      title: document.title,
      description: document.description,
      mimeType: document.mimeType,
      size: document.size,
      annotations: { audience: ['user' as const, 'assistant' as const] },
      _meta: { [META_KEY]: kb.metadata(document) },
    }));
    return { resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
  });

  server.server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));

  server.server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    const document = await kb.get(uri);
    if (!document) throw Object.assign(new Error('Resource not found'), { code: RESOURCE_NOT_FOUND, data: { uri } });
    return {
      contents: [
        {
          uri: document.uri,
          mimeType: 'text/markdown',
          text: readableText(kb, document),
          _meta: { [META_KEY]: kb.metadata(document) },
        },
      ],
    };
  });
}
