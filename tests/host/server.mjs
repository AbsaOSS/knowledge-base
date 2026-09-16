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
 * The host page's own router (tests/host/host-router.js, an Angular Router
 * stand-in) places <web-fragment fragment-id="knowledge-base"> in its outlet;
 * the gateway pulls the fragment HTML/assets through and reframes them into a
 * shadow root. Two shells: the unbound one on `/` (element with `src`) and the
 * bound one on `/knowledge-base/…` (no `src`) — see shell() below.
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
  // Client-rendered embed (no SSR piercing) by default — the Astro fragment
  // recipe. KB_PIERCING=true switches to server-side piercing, the mode a
  // production Angular SSR gateway runs in: the first page then arrives as
  // SSR markup inside a declarative shadow root and reframed adopts it, which
  // is a different starting tree for the ClientRouter than the client-rendered
  // wf-html/wf-head/wf-body one.
  piercing: process.env.KB_PIERCING === 'true',
  // One pattern for pages + _astro assets + ClientRouter fetches, one for the
  // /__wf/ knowledge base CSS route the sub-app HTML references.
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

// The Angular Router stand-in the shell loads (see the file's header comment).
app.get('/host-router.js', (_req, res) => res.sendFile(join(__dirname, 'host-router.js')));

/**
 * The host shell. The host's own router (tests/host/host-router.js, an Angular
 * Router stand-in) renders the `<web-fragment>` into `#host-outlet` from the
 * route table named by `routes`, so both ways of embedding are covered:
 *
 *   • unbound — the element carries a `src` (`fragmentSrc`); fragment routes stay
 *     inside the reframed iframe and never touch the address bar. `?wf=` on the
 *     landing URL picks that initial route, since the host URL cannot.
 *   • bound   — no `src`; the fragment's history is the host's history, so the
 *     host serves this shell for every `/knowledge-base/…` document request and
 *     the fragment's ClientRouter drives the address bar.
 */
function shell({ routes, fragmentSrc = null }) {
  const config = JSON.stringify({ mode: fragmentSrc ? 'unbound' : 'bound', routes, fragmentSrc });
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
    #host-shell-header nav{margin-left:auto;display:flex;gap:12px;font-weight:400}
    #host-shell-header a{color:#cbd5e1}
    #host-shell-badge{background:#2563eb;border-radius:4px;padding:2px 6px;font-size:11px}
    web-fragment{display:block;min-height:calc(100vh - 48px)}
  </style>
</head>
<body>
  <header id="host-shell-header">
    <span id="host-shell-badge">HOST</span>
    Test Host Shell — knowledge-base embedded as a web fragment
    <nav aria-label="Host navigation">
      <a id="host-nav-home" data-host-link href="${fragmentSrc ? '/host-home' : '/bound'}">Host home</a>
      <a id="host-nav-kb" data-host-link href="${fragmentSrc ? '/' : '/knowledge-base/'}">Knowledge base</a>
    </nav>
  </header>
  <main id="host-main">
    <div id="host-outlet"></div>
  </main>
  <script id="host-config" type="application/json">${config}</script>
  <script type="module">
    import { initializeWebFragments } from 'web-fragments';
    initializeWebFragments();
  </script>
  <!-- deferred so it runs AFTER the module above, exactly like an Angular host
       that calls initializeWebFragments() in main.ts before bootstrapping: a
       <web-fragment> created before web-fragment-host is defined cannot adopt
       a pierced host (portalHost is not yet a function on it). -->
  <script defer src="/host-router.js"></script>
</body>
</html>`;
}

function sendShell(res, options) {
  res.set('Content-Type', 'text/html; charset=utf-8').end(shell(options));
}

// Unbound shell: `?wf=` selects the fragment's initial route so tests can
// deep-link a sub-app page (the host URL cannot carry it in this mode).
app.get(['/', '/host', '/host-home'], (req, res) => {
  const requested = typeof req.query.wf === 'string' ? req.query.wf : '/knowledge-base/';
  // Only allow fragment routes — anything else falls back to the landing.
  const fragmentSrc = requested.startsWith('/knowledge-base/') ? requested : '/knowledge-base/';
  sendShell(res, { routes: 'unbound', fragmentSrc });
});

// Bound shell. The gateway lets a *document* request for a `piercing: false`
// fragment route through to the host, so the host must answer every
// `/knowledge-base/…` URL with the shell — exactly what an Angular wildcard
// route does. `?hostRoutes=narrow` swaps in the misconfigured route table.
app.get(['/bound', '/knowledge-base', '/knowledge-base/*splat'], (req, res) => {
  const routes = req.query.hostRoutes === 'narrow' ? 'bound-narrow' : 'bound-wide';
  sendShell(res, { routes });
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => {
  console.log(`▶ WF test host → http://localhost:${PORT}  (fragment endpoint: ${KB_ENDPOINT})`);
});
