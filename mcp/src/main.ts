// Entry point: `node mcp/src/main.ts [--http|--stdio] [--index file] [--host h] [--port p]`.
// Bundled to dist/_mcp/server.mjs, which finds search-index.json beside itself by default.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadSearchIndex } from './adapters/memory/search-index-repository.ts';
import { memoryKnowledgeBase, versionOf } from './compose.ts';
import { loadConfig } from './config.ts';
import { createServerFactory } from './protocol/server.ts';
import { createMcpHttpHandler } from './transport/http.ts';
import { createListener } from './transport/listener.ts';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig(process.argv.slice(2), process.env, join(here, 'search-index.json'));

const searchIndex = await loadSearchIndex(config.indexPath);
const kb = memoryKnowledgeBase(searchIndex, { publicOrigin: config.publicOrigin });
const createServer = createServerFactory(kb, { version: versionOf(searchIndex) });

if (config.mode === 'stdio') {
  await createServer().connect(new StdioServerTransport());
} else {
  const handler = createMcpHttpHandler(createServer, {
    allowedOrigins: config.allowedOrigins,
    trustedProxies: config.trustedProxies,
  });
  createListener(handler).listen(config.port, config.host, () => {
    process.stderr.write(`kb-mcp listening http://${config.host}:${config.port}/mcp\n`);
  });
}
