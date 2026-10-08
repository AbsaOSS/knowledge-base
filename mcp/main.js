import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { validateCorpus } from './corpus.js';
import { createIndex } from './search.js';
import { createKbMcpServer } from './server.js';
import { createMcpHttpHandler } from './http.js';

const args = process.argv.slice(2); const value = (flag, fallback) => args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const stdio = args.includes('--stdio'); const http = args.includes('--http') || !stdio;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(value('--corpus', process.env.KB_MCP_CORPUS ?? resolve(scriptDir, 'corpus.json')));
const host = value('--host', process.env.KB_MCP_HOST ?? '127.0.0.1'); const port = Number(value('--port', process.env.KB_MCP_PORT ?? '8081'));
const publicOrigin = process.env.KB_MCP_PUBLIC_ORIGIN;
if (publicOrigin) { const parsed = new URL(publicOrigin); if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('KB_MCP_PUBLIC_ORIGIN must be an http(s) origin without a path'); }
const corpus = validateCorpus(JSON.parse(readFileSync(corpusPath, 'utf8'))); const index = createIndex(corpus);
const version = corpus.generator.split('@')[1] ?? '1.0.0';
if (stdio) { const server = createKbMcpServer(index, { publicOrigin, version }); await server.connect(new StdioServerTransport()); }
else if (http) { const handler = createMcpHttpHandler(index, { allowedOrigins: (process.env.KB_MCP_ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean), publicOrigin, version }); const listener = createServer((req, res) => { if (req.url === '/healthz' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok\n'); } if (req.url !== '/mcp') { res.statusCode = 404; return res.end(); } return handler(req, res); }); listener.listen(port, host, () => process.stderr.write(`kb-mcp listening http://${host}:${port}/mcp\n`)); }
