/**
 * tests/fragment-server.mjs
 *
 * Serves the built knowledge-base (dist/) for E2E tests, faithfully mirroring the
 * production nginx config (nginx.conf) — NOT `astro preview`.
 *
 * Why not `astro preview`? For static output Astro uses its own preview server,
 * so the Vite `configurePreviewServer` hook in astro.config.mjs (the
 * /__wf/knowledge-base/* → /knowledge-base/* rewrite) never runs and the
 * knowledge base stylesheet 404s. In production nginx performs that rewrite, so this
 * server replicates nginx's two location rules to test the real contract:
 *
 *   /__wf/knowledge-base/<f>  → serve dist/<f>            (fragment assets)
 *   /knowledge-base/<f>       → serve dist/<f> (or /index.html)   (pages + assets)
 *
 * Env: KB_PORT (default 3000).
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { validateSearchIndex } from '../mcp/search-index/schema.ts';
import { memoryKnowledgeBase, versionOf } from '../mcp/src/compose.ts';
import { createServerFactory } from '../mcp/src/protocol/server.ts';
import { createMcpHttpHandler } from '../mcp/src/transport/http.ts';
import { sendBrowserError } from '../mcp/src/transport/error-page.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.KB_PORT || 3000);
const PREFIX = 'knowledge-base';

if (!existsSync(DIST)) {
  console.error(`✗ dist/ not found at ${DIST} — run "npm run build:headless" first.`);
  process.exit(1);
}
const MCP_SEARCH_INDEX = join(DIST, '_mcp', 'search-index.json');
if (!existsSync(MCP_SEARCH_INDEX)) {
  console.error(`✗ ${MCP_SEARCH_INDEX} missing — build step 3b did not run.`);
  process.exit(1);
}
const mcpIndex = validateSearchIndex(JSON.parse(readFileSync(MCP_SEARCH_INDEX, 'utf8')));
const mcpHandler = createMcpHttpHandler(createServerFactory(memoryKnowledgeBase(mcpIndex), { version: versionOf(mcpIndex) }));

/**
 * Kept byte-identical to the policy in nginx.headers.conf.
 * tests/nginx-config.spec.js asserts the two do not drift.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https: blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * nginx: map $request_uri $kb_cache_control — the caching policy per asset
 * class. Kept in step with nginx.conf; tests/nginx-config.spec.js asserts the
 * two agree on every value.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable, no-transform';
const REVALIDATE = 'no-cache, no-transform';
const IMMUTABLE_PATHS = [
  /^\/(__wf\/)?knowledge-base\/_astro\//,
  /^\/(__wf\/)?knowledge-base\/[^?]*\/_kb-inline\/[0-9a-f]{16}\.js(\?|$)/,
];
const cacheControl = (requestUri) =>
  IMMUTABLE_PATHS.some((re) => re.test(requestUri)) ? IMMUTABLE : REVALIDATE;

const app = express();

// nginx: MCP routes; shared Node handler keeps protocol guard parity.
app.all(`/${PREFIX}/mcp`, (req, res) => mcpHandler(req, res));
app.all(new RegExp(`^/${PREFIX}/mcp/`), (req, res) => {
  if (req.method === 'GET' || req.method === 'HEAD') return sendBrowserError(req, res, 404);
  return res.sendStatus(404);
});
// nginx: include /etc/nginx/kb-headers.conf — the shared CORS + security set.
// Applied to every response, which is what the nginx config does now that each
// location declaring an add_header re-includes the snippet. Kept in sync with
// nginx.headers.conf; tests/nginx-config.spec.js asserts the nginx side.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-web-fragment-id, x-fragment-mode',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin',
    // Same policy nginx.headers.conf serves. Mirrored here so the embedded
    // harness exercises it through the web-fragments gateway — a CSP that
    // breaks reframing fails silently, and this is where that would show up.
    'Content-Security-Policy': CSP,
  });
  // Only on the prefixed locations, as nginx sets it. An error response drops
  // it again: Express's final 404 handler clears every header, much as nginx's
  // add_header without `always` skips one.
  if (req.url.startsWith(`/${PREFIX}`) || req.url.startsWith(`/__wf/${PREFIX}/`)) {
    res.set('Cache-Control', cacheControl(req.url));
  }
  next();
});

// _mcp is runtime-only and must never be served by either static path.
app.use((req, res, next) => {
  if (!/^\/(__wf\/)?knowledge-base\/_mcp(?:\/|$)/.test(req.path)) return next();
  return res.status(404).sendFile(join(DIST, '_error', 'not-found.html'), { cacheControl: false });
});

// nginx: location ^~ /__wf/knowledge-base/ { rewrite ^/__wf/knowledge-base/(.*)$ /$1 }
// Map the fragment-asset prefix onto the normal page prefix so one static handler
// serves both (e.g. /__wf/knowledge-base/style.css → dist/style.css).
app.use((req, _res, next) => {
  if (req.url.startsWith(`/__wf/${PREFIX}/`)) {
    req.url = `/${PREFIX}/` + req.url.slice(`/__wf/${PREFIX}/`.length);
  }
  next();
});

// nginx: location = /knowledge-base { rewrite ^ /knowledge-base/ last; }
// An INTERNAL rewrite, not a redirect — nginx.conf is explicit that a 3xx here
// would expose the container's internal HTTP address to the browser and cause a
// mixed-content error when the host app is served over HTTPS. This mirror used
// to answer with a 308, i.e. the exact thing that comment forbids (#60).
// Must run before the static mount so the rewritten path is what it sees.
app.use((req, _res, next) => {
  if (req.url === `/${PREFIX}`) req.url = `/${PREFIX}/`;
  next();
});

// nginx: location ^~ /knowledge-base/ { rewrite strips prefix; try_files $uri $uri/index.html }
// express.static strips the mount path and resolves files from dist root.
//
// redirect:false is essential. serve-static answers a directory path that lacks
// a trailing slash with a 301, whereas nginx's try_files just serves
// {path}/index.html with a 200 — verified against the image: /knowledge-base,
// /knowledge-base/user-guide and their trailing-slash forms are all 200, no
// Location header anywhere. A mirror that redirects is testing a contract the
// production server does not have.
app.use(
  `/${PREFIX}`,
  express.static(DIST, { extensions: ['html'], index: 'index.html', redirect: false, cacheControl: false }),
);

// nginx: the `$uri/index.html` half of try_files — a directory path resolves to
// its index without a redirect, trailing slash or not.
app.use(`/${PREFIX}`, (req, res, next) => {
  const candidate = join(DIST, decodeURIComponent(req.path), 'index.html');
  // Never serve outside dist/, whatever the request path claims.
  if (!candidate.startsWith(DIST)) return next();
  if (!existsSync(candidate)) return next();
  res.sendFile(candidate, { cacheControl: false });
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// nginx: error_page 404 /__kb-not-found; all missing browser routes share page.
app.use((_req, res) => res.status(404).sendFile(join(DIST, '_error', 'not-found.html'), { cacheControl: false }));

app.listen(PORT, () => {
  console.log(`▶ knowledge-base fragment server → http://localhost:${PORT}/${PREFIX}/  (dist/, nginx-mirror)`);
});
