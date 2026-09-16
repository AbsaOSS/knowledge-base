/**
 * tests/host/host-router.js
 *
 * Stand-in for the production host's Angular Router, loaded by the test host
 * shell (tests/host/server.mjs). It is not Angular — bundling @angular/router
 * into this harness would cost a whole Angular toolchain for three behaviours —
 * but it reproduces exactly the three things Angular's Router does that can
 * clash with a fragment's own client router:
 *
 *   1. It owns the address bar. Every host navigation ends in history.pushState,
 *      or replaceState when the browser is already at that URL (Router.setBrowserUrl),
 *      always with the router's OWN state object ({ navigationId, ɵrouterPageId })
 *      and with the path normalised the way Angular's Location does it: trailing
 *      slash stripped.
 *   2. It listens to window `popstate` (PlatformLocation.onPopState) and, one
 *      macrotask later, re-routes to the browser's new URL against its route
 *      config. A URL nothing matches lands on the `**` fallback. A popstate to
 *      the URL it is already on is skipped (onSameUrlNavigation: 'ignore').
 *   3. It reuses the outlet component when the matched route config is the same
 *      object as before (BaseRouteReuseStrategy: future.routeConfig ===
 *      curr.routeConfig) and destroys + recreates it otherwise.
 *
 * The shell picks a route table by name (see ROUTE_TABLES). `window.__hostRouter`
 * exposes the navigation log so tests can assert what the host saw.
 */
(function bootHostRouter() {
  const config = JSON.parse(document.getElementById('host-config').textContent);

  const COMPONENTS = {
    kb() {
      const src = config.fragmentSrc ? ` src="${config.fragmentSrc}"` : '';
      return `<web-fragment fragment-id="knowledge-base"${src} data-testid="knowledge-base-web-fragment"></web-fragment>`;
    },
    home() {
      return '<section id="host-home"><h2>Host home</h2><p>A host-owned page. No fragment is mounted here.</p></section>';
    },
    notFound() {
      return '<section id="host-not-found"><h2>Host 404</h2><p>The host router matched nothing for this URL.</p></section>';
    },
  };

  // Angular route configs, in the only two shapes that matter here. A path
  // ending in "/**" is a wildcard child route; "**" alone is the app fallback.
  const ROUTE_TABLES = {
    // Unbound shell: the fragment lives on the host's own landing route and
    // carries a `src`. Its routes never surface in the address bar.
    unbound: [
      { path: '/', component: 'kb' },
      { path: '/host', component: 'kb' },
      { path: '/host-home', component: 'home' },
      { path: '**', component: 'notFound' },
    ],
    // Bound shell, correct config: one component for the whole fragment prefix.
    'bound-wide': [
      { path: '/bound', component: 'home' },
      { path: '/knowledge-base/**', component: 'kb' },
      { path: '**', component: 'notFound' },
    ],
    // Bound shell, the mistake: only the fragment's entry route is registered,
    // so the first in-fragment navigation falls through to the host's 404.
    'bound-narrow': [
      { path: '/bound', component: 'home' },
      { path: '/knowledge-base', component: 'kb' },
      { path: '**', component: 'notFound' },
    ],
  };

  const routes = ROUTE_TABLES[config.routes];
  if (!routes) throw new Error(`host-router: unknown route table "${config.routes}"`);

  const outlet = document.getElementById('host-outlet');
  const log = { navigations: [], activations: [], popstates: 0, skipped: 0 };
  let navigationId = 0;
  let current = { url: null, route: null };

  /** Angular Location.normalize: strip the trailing slash (root stays "/"). */
  function normalize(rawUrl) {
    const url = new URL(rawUrl, location.origin);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path + url.search;
  }

  function match(url) {
    const bare = url.split('?')[0];
    return routes.find((route) => {
      if (route.path === '**') return true;
      if (route.path.endsWith('/**')) {
        const prefix = route.path.slice(0, -3);
        return bare === prefix || bare.startsWith(prefix + '/');
      }
      return route.path === bare;
    });
  }

  /** Router.setBrowserUrl: replace when already there, push otherwise. */
  function setBrowserUrl(url) {
    navigationId += 1;
    const state = { navigationId, ɵrouterPageId: navigationId };
    if (normalize(location.pathname + location.search) === url) {
      history.replaceState(state, '', url);
    } else {
      history.pushState(state, '', url);
    }
  }

  function activate(url, route, source) {
    const reused = current.route === route;
    log.navigations.push({ url, source, component: route.component, reused });
    if (!reused) {
      outlet.innerHTML = '';
      outlet.innerHTML = COMPONENTS[route.component]();
      log.activations.push(route.component);
    }
    current = { url, route };
  }

  function navigate(rawUrl, source = 'imperative') {
    const url = normalize(rawUrl);
    if (source === 'popstate' && url === current.url) {
      log.skipped += 1;
      return;
    }
    const route = match(url);
    setBrowserUrl(url);
    activate(url, route, source);
  }

  window.addEventListener('popstate', () => {
    log.popstates += 1;
    setTimeout(() => navigate(location.pathname + location.search, 'popstate'), 0);
  });

  // RouterLink: host-authored anchors navigate through the router. Clicks that
  // originate inside the fragment's shadow tree are retargeted to the
  // <web-fragment> element and never match a host anchor.
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[data-host-link]') : null;
    if (!anchor || event.defaultPrevented || event.button !== 0) return;
    event.preventDefault();
    navigate(anchor.getAttribute('href'));
  });

  window.__hostRouter = {
    config,
    log,
    navigate,
    currentUrl: () => current.url,
  };

  navigate(location.pathname + location.search, 'initial');
})();
