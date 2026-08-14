/**
 * tests/fragment-server.mjs
 *
 * Serves the built knowledge-base (dist/) for E2E tests, faithfully mirroring the
 * production nginx config (nginx.conf) — NOT `astro preview`.
 *
 * Why not `astro preview`? For static output Astro uses its own preview server,
 * so the Vite `configurePreviewServer` hook in astro.config.mjs (the
 * /__wf/knowledge-base/* → /knowledge-base/* rewrite) never runs and the
 * marketplace stylesheet 404s. In production nginx performs that rewrite, so this
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
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.KB_PORT || 3000);
const PREFIX = 'knowledge-base';

if (!existsSync(DIST)) {
  console.error(`✗ dist/ not found at ${DIST} — run "npm run build:headless" first.`);
  process.exit(1);
}

const app = express();

// nginx: include /etc/nginx/kb-headers.conf — the shared CORS + security set.
// Applied to every response, which is what the nginx config does now that each
// location declaring an add_header re-includes the snippet. Kept in sync with
// nginx.headers.conf; tests/nginx-config.spec.js asserts the nginx side.
app.use((_req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-web-fragment-id, x-fragment-mode',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin',
  });
  next();
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

// nginx: location ^~ /knowledge-base/ { rewrite strips prefix; try_files $uri $uri/index.html }
// express.static strips the mount path and resolves files from dist root.
app.use(
  `/${PREFIX}`,
  express.static(DIST, { extensions: ['html'], index: 'index.html' }),
);

// nginx: location = /knowledge-base { rewrite ^ /knowledge-base/ }
app.get(`/${PREFIX}`, (_req, res) => res.redirect(308, `/${PREFIX}/`));

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => {
  console.log(`▶ knowledge-base fragment server → http://localhost:${PORT}/${PREFIX}/  (dist/, nginx-mirror)`);
});
