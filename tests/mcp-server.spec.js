import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMcp } from './support/mcp.js';

const searchIndex = JSON.parse(readFileSync(join(process.cwd(), 'dist', '_mcp', 'search-index.json'), 'utf8'));
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

async function start(options = {}) {
  const service = await startMcp(searchIndex, options);
  const request = async (body, init = {}) => {
    const response = await fetch(service.url, {
      method: init.method ?? 'POST',
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      body: init.method && init.method !== 'POST' ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await response.text();
    return { response, body: text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null, text };
  };
  return { request, close: service.close };
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
      expect(get.response.headers.get('content-type')).toContain('text/html');
      expect(get.body).toBeNull();
      expect(get.text).toContain('MCP client required');
      expect(get.text).toContain('/knowledge-base/mcp');
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

  test('one client exhausting its rate limit does not lock out another', async () => {
    const service = await start({ limits: { rps: 0, burst: 1 } });
    try {
      const noisy = { headers: { 'x-forwarded-for': '203.0.113.1' } };
      expect((await service.request(initialize, noisy)).response.status).toBe(200);
      expect((await service.request(initialize, noisy)).response.status).toBe(429);
      // Only the right-most hop is trusted: a spoofed left-most entry is still the same client.
      expect((await service.request(initialize, { headers: { 'x-forwarded-for': '198.51.100.9, 203.0.113.1' } })).response.status).toBe(429);
      expect((await service.request(initialize, { headers: { 'x-forwarded-for': '203.0.113.2' } })).response.status).toBe(200);
    } finally { await service.close(); }

    const backstop = await start({ limits: { globalRps: 0, globalBurst: 1 } });
    try {
      expect((await backstop.request(initialize, { headers: { 'x-forwarded-for': '203.0.113.1' } })).response.status).toBe(200);
      expect((await backstop.request(initialize, { headers: { 'x-forwarded-for': '203.0.113.2' } })).response.status).toBe(429);
    } finally { await backstop.close(); }
  });

  test('a hostile JSON-RPC method neither crashes the handler nor reaches the log unescaped', async () => {
    const service = await start();
    const writes = [];
    const write = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); };
    try {
      const hostile = await service.request({ jsonrpc: '2.0', id: 1, method: { toString: 1 } });
      expect(hostile.response.status).toBeGreaterThanOrEqual(400);
      await service.request({ jsonrpc: '2.0', id: 2, method: 'x\nkb-mcp forged 200 initialize 0ms' });
      expect((await service.request(initialize)).response.status).toBe(200);
    } finally { process.stderr.write = write; await service.close(); }
    const lines = writes.filter((line) => line.startsWith('kb-mcp '));
    expect(lines).toHaveLength(3);
    expect(lines.slice(0, 2).every((line) => / unknown \d+ms\n$/.test(line))).toBe(true);
    expect(writes.join('')).not.toContain('forged');
  });

  test('CORS preflight allows POST and MCP headers only for listed origins', async () => {
    const service = await start({ allowedOrigins: ['https://allowed.example'] });
    try {
      const allowed = await service.request(null, { method: 'OPTIONS', headers: { origin: 'https://allowed.example' } });
      expect(allowed.response.status).toBe(204);
      expect(allowed.response.headers.get('access-control-allow-methods')).toContain('POST');
      expect(allowed.response.headers.get('access-control-allow-headers')).toContain('Mcp-Protocol-Version');
      const denied = await service.request(null, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
      expect(denied.response.headers.get('access-control-allow-methods')).toBeNull();
    } finally { await service.close(); }
  });

  test('a truncated resource read points read_document at the first unseen character', async () => {
    const text = Array.from({ length: 30000 }, (_, i) => `w${i}`).join(' ');
    const service = await startMcp({ schemaVersion: 1, contentHash: 'big', generator: 'knowledge-base@1.0.0', indexedAt: 'now', apps: [{ slug: 'big', name: 'B'.repeat(150), description: '', tags: [] }], documents: [{ uri: 'kb://big', app: 'big', route: '/knowledge-base/big/', title: 'T'.repeat(200), description: '', tags: [], mimeType: 'text/markdown', sourceVersion: 'test', sha256: '0'.repeat(64), size: text.length, truncated: false, text, sections: [] }] }, { publicOrigin: 'https://docs.example.com' });
    try {
      const response = await fetch(service.url, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'mcp-protocol-version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'kb://big' } }) });
      const shown = (await response.json()).result.contents[0].text;
      const offset = Number(shown.match(/offset: (\d+)\}\]$/)[1]);
      const body = shown.slice(shown.indexOf('---\n') + 4, shown.lastIndexOf('\n\n[truncated'));
      expect(body).toBe(text.slice(0, offset));
    } finally { await service.close(); }
  });
});
