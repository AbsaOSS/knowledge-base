import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createKbMcpServer } from './server.js';

const DEFAULT_LIMITS = { rps: 50, burst: 100, maxInFlight: 32, maxBodyBytes: 65536, timeoutMs: 10000 };
const rpcError = (res, status, message, extra = {}) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); for (const [key, value] of Object.entries(extra)) res.setHeader(key, value); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null })); };
const readBody = (req, cap) => new Promise((resolve, reject) => { let size = 0, rejected = false; const parts = []; req.on('data', (part) => { size += part.length; if (size > cap && !rejected) { rejected = true; reject(Object.assign(new Error('too large'), { code: 'SIZE' })); } else if (!rejected) parts.push(part); }); req.on('end', () => { if (!rejected) resolve(Buffer.concat(parts).toString()); }); req.on('error', reject); });

/** Stateless, read-only MCP HTTP handler. Host header needs no validation: loopback only, public data. */
export function createMcpHttpHandler(index, { allowedOrigins = [], publicOrigin, version, resourcePageSize, limits: suppliedLimits = {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...suppliedLimits }; let tokens = limits.burst, previous = Date.now(), inFlight = 0;
  return async (req, res) => {
    const start = Date.now(); res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('Allow', 'POST'); return res.end(); }
    const origin = req.headers.origin; if (origin && !allowedOrigins.includes(origin)) return rpcError(res, 403, 'Origin not allowed');
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return rpcError(res, 415, 'Content-Type must be application/json');
    let body;
    try { body = JSON.parse(await readBody(req, limits.maxBodyBytes)); } catch (error) { if (error.code === 'SIZE') return rpcError(res, 413, 'Request body too large'); res.statusCode = 400; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null })); }
    const now = Date.now(); tokens = Math.min(limits.burst, tokens + ((now - previous) / 1000) * limits.rps); previous = now;
    if (tokens < 1) return rpcError(res, 429, 'Rate limit exceeded', { 'Retry-After': '1' }); tokens -= 1;
    if (inFlight >= limits.maxInFlight) return rpcError(res, 503, 'Server busy', { 'Retry-After': '1' }); inFlight += 1;
    let timeout;
    try {
      const server = createKbMcpServer(index, { publicOrigin, version, resourcePageSize });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      timeout = setTimeout(() => { if (!res.writableEnded) rpcError(res, 503, 'Request timed out', { 'Retry-After': '1' }); }, limits.timeoutMs);
      await transport.handleRequest(req, res, body);
      await transport.close(); await server.close();
    } catch (_error) { if (!res.writableEnded) rpcError(res, 500, 'Internal server error'); }
    finally { clearTimeout(timeout); inFlight -= 1; if (!res.writableEnded) res.end(); process.stderr.write(`kb-mcp ${new Date().toISOString()} ${res.statusCode || 200} ${body?.method ?? 'unknown'} ${Date.now() - start}ms\n`); }
  };
}
