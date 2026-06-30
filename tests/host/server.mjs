/**
 * tests/host/server.mjs
 *
 * Minimal "wrapping web-fragment application" — the HOST shell the knowledge-base
 * is embedded into during E2E tests. This stands in for the production host
 * (an Angular SSR gateway); the web-fragment runtime behaviour (shadow DOM
 * reframing, single-origin proxying, SPA routing) is identical regardless of the
 * host framework, so a tiny Express host is the most reproducible way to test it.
 *
 * Architecture:
 *
 *   browser ──► host (Express, this file, :4201)
 *                 │  FragmentGateway middleware matches /knowledge-base/* and
 *                 │  /__wf/knowledge-base/* and PROXIES them onto the host's
 *                 │  single origin from the fragment endpoint…
 *                 └──► knowledge-base (astro preview, :3000)
 *
 * The host page places <web-fragment fragment-id="knowledge-base">; the gateway
 * pulls the fragment HTML/assets through and reframes them into a shadow root.
 *
 * Env:
 *   HOST_PORT     host listen port              (default 4201)
 *   KB_ENDPOINT   knowledge-base origin to proxy (default http://localhost:3000)
 */

import express from 'express';
import { FragmentGateway } from 'web-fragments/gateway';
import { getNodeMiddleware } from 'web-fragments/gateway/node';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const PORT = Number(process.env.HOST_PORT || 4201);
const KB_ENDPOINT = process.env.KB_ENDPOINT || 'http://localhost:3000';

// ── Gateway ────────────────────────────────────────────────────────────────
const gateway = new FragmentGateway();
gateway.registerFragment({
  fragmentId: 'knowledge-base',
  endpoint: KB_ENDPOINT,
  // Client-rendered embed (no SSR piercing) — matches the Astro fragment recipe.
  piercing: false,
  // One pattern for pages + _astro assets + ClientRouter fetches, one for the
  // /__wf/ marketplace CSS route the sub-app HTML references.
  routePatterns: ['/knowledge-base/:_*', '/__wf/knowledge-base/:_*'],
  onSsrFetchError: () => ({
    response: new Response('<p>knowledge-base fragment endpoint unreachable</p>', {
      headers: { 'content-type': 'text/html' },
    }),
  }),
});

const app = express();

// Fragment middleware MUST come before any static/catch-all host routes.
app.use(getNodeMiddleware(gateway, { mode: 'development' }));

// Serve the web-fragments client bundle referenced by the shell's import map.
app.use('/_wf', express.static(join(ROOT, 'node_modules', 'web-fragments', 'dist')));

/**
 * The host shell. `?wf=` selects the fragment's initial route so tests can
 * deep-link a specific sub-app page (fragment-internal routes aren't
 * address-bar deep-linkable on their own — see the Astro fragment notes).
 */
function shell(initialFragmentRoute) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WF Test Host — knowledge-base</title>
  <script type="importmap">{ "imports": { "web-fragments": "/_wf/elements.js" } }</script>
  <style>
    *{box-sizing:border-box}
    body{margin:0;font-family:system-ui,sans-serif;background:#f5f6f8}
    #host-shell-header{height:48px;display:flex;align-items:center;gap:8px;padding:0 16px;
      background:#0b1220;color:#fff;font-weight:600;font-size:14px}
    #host-shell-badge{background:#2563eb;border-radius:4px;padding:2px 6px;font-size:11px}
    web-fragment{display:block;min-height:calc(100vh - 48px)}
  </style>
</head>
<body>
  <header id="host-shell-header">
    <span id="host-shell-badge">HOST</span>
    Test Host Shell — knowledge-base embedded as a web fragment
  </header>
  <main id="host-main">
    <web-fragment
      fragment-id="knowledge-base"
      src="${initialFragmentRoute}"
      data-testid="knowledge-base-web-fragment"></web-fragment>
  </main>
  <script type="module">
    import { initializeWebFragments } from 'web-fragments';
    initializeWebFragments();
  </script>
</body>
</html>`;
}

app.get(['/', '/host'], (req, res) => {
  const requested = typeof req.query.wf === 'string' ? req.query.wf : '/knowledge-base/';
  // Only allow fragment routes — anything else falls back to the landing.
  const initial = requested.startsWith('/knowledge-base/') ? requested : '/knowledge-base/';
  res.set('Content-Type', 'text/html; charset=utf-8').end(shell(initial));
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => {
  console.log(`▶ WF test host → http://localhost:${PORT}  (fragment endpoint: ${KB_ENDPOINT})`);
});
