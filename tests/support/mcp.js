// The one place tests construct the MCP runtime. Everything else talks HTTP to it, so the
// golden suite pins protocol behaviour, not module layout.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { validateSearchIndex } from '../../mcp/search-index/schema.ts';
import { memoryKnowledgeBase, versionOf } from '../../mcp/src/compose.ts';
import { createServerFactory } from '../../mcp/src/protocol/server.ts';
import { createMcpHttpHandler } from '../../mcp/src/transport/http.ts';

export const PROTOCOL_VERSION = '2025-11-25';

/**
 * Start an in-process MCP HTTP endpoint over `search index`; resolves to { url, rpc, request, close }.
 * `publicOrigin` and `resourcePageSize` configure the server; the rest go to the HTTP handler.
 */
export async function startMcp(searchIndex, { publicOrigin, resourcePageSize, ...http } = {}) {
  const valid = validateSearchIndex(searchIndex);
  const kb = memoryKnowledgeBase(valid, { publicOrigin });
  const handler = createMcpHttpHandler(createServerFactory(kb, { version: versionOf(valid), resourcePageSize }), http);
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = connect(`http://127.0.0.1:${server.address().port}/mcp`);
  return { ...client, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Start the bundled server (`node server.mjs --http`) on a free port over a search index file;
 * resolves once it answers its health check.
 */
export async function spawnBundle(bundle, indexFile, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [bundle, '--http', '--port', String(port), '--index', indexFile], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch { /* not listening yet */ }
    if (child.exitCode !== null || attempt > 100) throw new Error(`bundle did not start: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const client = connect(`http://127.0.0.1:${port}/mcp`);
  return { ...client, close: async () => { child.kill(); await exited; } };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** An HTTP client for one MCP endpoint: raw `request`, and `rpc` at the pinned protocol version. */
export function connect(url) {
  let id = 0;

  /** Raw HTTP exchange; returns status, headers and the parsed JSON body (or text). */
  const request = async (body, { method = 'POST', headers = {} } = {}) => {
    const response = await fetch(url, {
      method,
      headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await response.text();
    const json = response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : null;
    return { status: response.status, headers: response.headers, body: json, text };
  };

  /** One JSON-RPC call at the pinned protocol version. */
  const rpc = async (method, params = {}) => {
    id += 1;
    const headers = method === 'initialize' ? {} : { 'mcp-protocol-version': PROTOCOL_VERSION };
    return request({ jsonrpc: '2.0', id, method, params }, { headers });
  };

  return { url, rpc, request };
}
