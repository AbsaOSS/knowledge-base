import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCorpus } from '../mcp/corpus.js';
import { createIndex } from '../mcp/search.js';
import { createMcpHttpHandler } from '../mcp/http.js';

const corpus = validateCorpus(JSON.parse(readFileSync(join(process.cwd(), 'dist', '_mcp', 'corpus.json'), 'utf8')));
const index = createIndex(corpus);
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

async function start(options = {}) {
  const handler = createMcpHttpHandler(index, options);
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const request = async (body, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: init.method ?? 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      body: init.method && init.method !== 'POST' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  };
  return { request, close: () => new Promise((resolve) => server.close(resolve)) };
}

test.describe('MCP in-process HTTP protocol', () => {
  test('initialize advertises resources and tools; tools publish matching structured output', async () => {
    const service = await start();
    try {
      const init = await service.request(initialize);
      expect(init.response.status).toBe(200);
      expect(init.response.headers.get('cache-control')).toBe('no-store');
      expect(init.response.headers.get('mcp-session-id')).toBeNull();
      expect(init.body.result.capabilities).toEqual({ resources: { listChanged: false, subscribe: false }, tools: { listChanged: false } });
      expect(init.body.result.instructions).toContain('Knowledge Base documentation server');
      expect(init.body.result.serverInfo.name).toBe('knowledge-base-mcp-server');

      const tools = await service.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      expect(tools.body.result.tools.map((tool) => tool.name)).toEqual(['search_documents', 'list_documents', 'read_document']);
      expect(tools.body.result.tools.every((tool) => tool.inputSchema && tool.outputSchema && tool.annotations.readOnlyHint)).toBe(true);
      expect(tools.body.result.tools.every((tool) => tool.inputSchema.additionalProperties === false && tool.outputSchema.additionalProperties === false)).toBe(true);

      const call = await service.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_documents', arguments: { query: 'release process' } } }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      const result = call.body.result;
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      expect(result.structuredContent.results[0].uri).toBe('kb://release-process');
      expect(result.content.some((content) => content.type === 'resource_link')).toBe(true);
    } finally { await service.close(); }
  });

  test('resources paginate deterministically and resource read handles known and unknown URIs', async () => {
    const service = await start({ resourcePageSize: 2 });
    try {
      const first = await service.request({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      expect(first.body.result.resources).toHaveLength(2);
      expect(first.body.result.nextCursor).toBeTruthy();
      const second = await service.request({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: { cursor: first.body.result.nextCursor } }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      expect(second.body.result.resources).toHaveLength(2);
      expect(second.body.result.resources[0].uri).not.toBe(first.body.result.resources[0].uri);

      const known = await service.request({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: first.body.result.resources[0].uri } }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      expect(known.body.result.contents[0].mimeType).toBe('text/markdown');
      expect(known.body.result.contents[0].text).toContain('Title:');
      const unknown = await service.request({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'kb://missing' } }, { headers: { 'mcp-protocol-version': '2025-11-25' } });
      expect(unknown.body.error.message).toContain('Resource not found');
    } finally { await service.close(); }
  });

  test('HTTP guards reject unsafe requests and rate-limit valid requests', async () => {
    const service = await start({ allowedOrigins: ['https://allowed.example'] });
    try {
      const get = await service.request(null, { method: 'GET' });
      expect(get.response.status).toBe(405); expect(get.response.headers.get('allow')).toBe('POST');
      const plain = await service.request(initialize, { headers: { 'content-type': 'text/plain' } });
      expect(plain.response.status).toBe(415);
      const origin = await service.request(initialize, { headers: { origin: 'https://evil.example' } });
      expect(origin.response.status).toBe(403);
      const allowed = await service.request(initialize, { headers: { origin: 'https://allowed.example' } });
      expect(allowed.response.status).toBe(200);
      const large = await service.request('x'.repeat(65537));
      expect(large.response.status).toBe(413);
    } finally { await service.close(); }

    const limited = await start({ limits: { rps: 0, burst: 1 } });
    try {
      expect((await limited.request(initialize)).response.status).toBe(200);
      const second = await limited.request(initialize);
      expect(second.response.status).toBe(429);
      expect(second.response.headers.get('retry-after')).toBe('1');
    } finally { await limited.close(); }
  });
});
