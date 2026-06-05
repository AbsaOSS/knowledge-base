/**
 * Knowledge base persistent top chrome template.
 *
 * Renders a 56px fixed header that replaces the site-level header
 * stripped from headless sub-site pages.
 *
 * @param {Array}  apps        - All registered apps from apps.json
 * @param {string} activeSlug  - Slug of the currently active app (or '' for landing)
 * @param {string} rootRel     - Relative path back to knowledge base root (e.g. '../../')
 * @param {string} prefix      - Optional path prefix (e.g. 'knowledge-base'). When set,
 *                               all internal links use `{prefix}/{path}` instead of rootRel-relative paths.
 */
export function chromeHtml(apps, activeSlug = '', rootRel = '/', prefix = '') {
  const BRICKS_SM = `
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
  <rect class="logo-brick-1" x="1"  y="1"  width="8" height="8" rx="1.5" fill="currentColor"/>
  <rect class="logo-brick-2" x="11" y="1"  width="8" height="8" rx="1.5" fill="currentColor" opacity="0.7"/>
  <rect class="logo-brick-3" x="1"  y="11" width="8" height="8" rx="1.5" fill="currentColor" opacity="0.5"/>
</svg>`.trim();

  const I_CHEVRON_DOWN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
  const I_MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const I_SUN  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  const I_HOME = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;

  const activeApp = apps.find(a => a.slug === activeSlug);

  // When a prefix is set, all internal links are absolute `/{prefix}/{path}`.
  // Otherwise, links are relative via rootRel (e.g. '../../').
  const link = (path) => prefix ? `/${prefix}/${path}` : `${rootRel}${path}`;

  const appItems = apps.map(app => {
    const isActive = app.slug === activeSlug;
    const href = link(`${app.slug}/`);
    return `<a href="${href}" class="mp-app-item${isActive ? ' active' : ''}" aria-current="${isActive ? 'page' : 'false'}">
      ${appIconSvg(app.icon, 14)}
      <span>${escHtml(app.name)}</span>
    </a>`;
  }).join('\n      ');

  const switcherLabel = activeApp
    ? `<span class="hidden sm:inline">${escHtml(activeApp.name)}</span>`
    : `<span class="hidden sm:inline">All Apps</span>`;

  return `<div id="mp-chrome" role="banner">
  <!-- Brand -->
  <div class="flex items-center gap-3">
    <a href="${link('index.html')}" class="flex items-center gap-2 text-absa-500 hover:opacity-80 transition-opacity no-underline" aria-label="Knowledge base home">
      ${BRICKS_SM}
    </a>
    <span class="text-[13px] font-semibold tracking-[-0.01em] select-none" style="color:var(--text-heading)">Knowledge base</span>
    ${activeApp ? `<span class="text-[13px] select-none" style="color:var(--text-hint)">/</span>
    <span class="text-[13px] font-medium" style="color:var(--text-body)">${escHtml(activeApp.name)}</span>` : ''}
  </div>

  <!-- Right side: app switcher + theme toggle -->
  <div class="flex items-center gap-1">
    <!-- Home link -->
    <a href="${link('index.html')}"
       class="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800 no-underline"
       style="color:var(--text-muted)"
       aria-label="Back to marketplace">
      ${I_HOME}
      <span>Marketplace</span>
    </a>

    <!-- App switcher -->
    <div id="mp-app-switcher" class="relative">
      <button
        onclick="document.getElementById('mp-app-switcher').classList.toggle('open')"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
        style="color:var(--text-body)"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-label="Switch documentation app">
        ${appIconSvg(activeApp?.icon || 'collection', 13)}
        ${switcherLabel}
        ${I_CHEVRON_DOWN}
      </button>
      <div id="mp-app-dropdown" role="listbox" aria-label="Documentation apps">
        ${appItems}
      </div>
    </div>

    <!-- Theme toggle -->
    <button
      onclick="toggleTheme()"
      class="p-2 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-800"
      style="color:var(--text-muted)"
      aria-label="Toggle colour theme">
      <span class="dark:hidden">${I_MOON}</span>
      <span class="hidden dark:block">${I_SUN}</span>
    </button>
  </div>
</div>`;
}

/**
 * Client-side SPA router for the marketplace (non-headless mode).
 *
 * Intercepts clicks on same-prefix links and swaps page content via
 * fetch+DOM-manipulation instead of triggering a full browser navigation.
 *
 * Design:
 *  - Intercepts all a[href] clicks whose href starts with /{prefix}/
 *  - Preloads new stylesheets before the swap to avoid FOUC
 *  - Injects new external scripts from the target page (async enhancement)
 *  - Syncs body-element attributes so layout classes stay correct across page types
 *  - Swaps #mp-chrome (updates active-app state in the switcher), then the rest
 *  - Re-executes inline classic <script> tags from the new content
 *  - Pushes history BEFORE re-running scripts (so scripts see the correct URL)
 *  - Handles browser back/forward via popstate (no scroll-to-top restoration)
 *  - AbortController cancels any in-flight fetch on a new navigation
 *  - Falls back to a hard navigation on error or non-HTML response
 *
 * @param {string} prefix - e.g. 'knowledge-base'
 */
export function marketplaceRouterScript(prefix) {
  const scope = prefix ? `/${prefix}/` : '/';
  return `<script data-mp-router>
(function () {
  var SCOPE = '${scope}';
  var _ctrl = null; // AbortController for in-flight request

  // Re-execute inline classic scripts from newly inserted content.
  // Uses indirect eval so the code runs in the current window context
  // (safe here — we only eval scripts already present in the fetched page).
  // Skips module scripts, external scripts, and our own injected scripts.
  function runScripts(root) {
    root.querySelectorAll(
      'script:not([src]):not([type="module"]):not([data-mp-router]):not([data-mp-fragment-router])'
    ).forEach(function (s) {
      try { (0, eval)(s.textContent); } catch (e) {
        console.warn('[mp-router] script eval error:', e);
      }
    });
  }

  // Inject external scripts (src) from the target page that are not yet
  // loaded. They execute asynchronously — used for progressive enhancement
  // when navigating between apps whose JS bundles differ.
  function syncScripts(doc) {
    var loaded = new Set(
      Array.from(document.head.querySelectorAll('script[src]')).map(function (s) { return s.src; })
    );
    Array.from(doc.head.querySelectorAll('script[src]')).forEach(function (ns) {
      if (loaded.has(ns.src)) return;
      var s = document.createElement('script');
      s.src = ns.src;
      if (ns.type)        s.type = ns.type;
      if (ns.crossOrigin) s.crossOrigin = ns.crossOrigin;
      document.head.appendChild(s);
    });
  }

  // Sync <link rel="stylesheet"> between current and target page.
  // Preloads new sheets (awaited) to prevent FOUC, then removes stale ones.
  function syncStylesheets(doc) {
    var curLinks = Array.from(document.head.querySelectorAll('link[rel="stylesheet"]'));
    var newLinks = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]'));
    var newHrefs = new Set(newLinks.map(function (l) { return l.href; }));
    var curHrefs = new Set(curLinks.map(function (l) { return l.href; }));
    return Promise.all(newLinks.map(function (l) {
      if (curHrefs.has(l.href)) return Promise.resolve();
      return new Promise(function (resolve) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = l.href;
        link.onload = resolve;
        link.onerror = resolve;
        document.head.appendChild(link);
      });
    })).then(function () {
      curLinks.forEach(function (l) { if (!newHrefs.has(l.href)) l.remove(); });
    });
  }

  function navigate(url, updateHistory) {
    if (_ctrl) _ctrl.abort();
    _ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;

    document.documentElement.setAttribute('data-mp-navigating', '');
    fetch(url, { credentials: 'same-origin', signal: _ctrl ? _ctrl.signal : undefined })
      .then(function (r) {
        var ct = r.headers.get('Content-Type') || '';
        if (!r.ok || !ct.includes('text/html')) throw new Error('non-HTML: ' + r.status);
        return r.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        return syncStylesheets(doc).then(function () {
          // Inject new external scripts (async, non-blocking)
          syncScripts(doc);

          // Sync body-element attributes so layout classes/styles stay correct
          // (e.g. landing uses "mp-wrapped min-h-screen flex flex-col")
          Array.from(document.body.attributes).forEach(function (a) {
            if (!doc.body.hasAttribute(a.name)) document.body.removeAttribute(a.name);
          });
          Array.from(doc.body.attributes).forEach(function (a) {
            document.body.setAttribute(a.name, a.value);
          });

          // Swap #mp-chrome (updates active-app indicator in the switcher)
          var newChrome = doc.getElementById('mp-chrome');
          var curChrome = document.getElementById('mp-chrome');
          if (newChrome && curChrome) curChrome.replaceWith(newChrome);

          // Replace all body children that are not the chrome bar
          Array.from(document.body.children).forEach(function (el) {
            if (el.id !== 'mp-chrome') el.remove();
          });
          Array.from(doc.body.children).forEach(function (el) {
            if (el.id !== 'mp-chrome') document.body.appendChild(el);
          });

          // Update title + history BEFORE re-running scripts so they see
          // the correct window.location / document.title.
          document.title = doc.title;
          if (updateHistory !== false) {
            history.pushState(null, doc.title, url);
          }

          // Re-execute inline classic scripts from the new content
          runScripts(document.body);

          // Scroll: forward nav → hash target or page top; popstate → restore
          if (updateHistory !== false) {
            var hash = new URL(url, window.location.href).hash;
            if (hash) {
              var target = document.querySelector(hash);
              if (target) { target.scrollIntoView(); }
            } else {
              window.scrollTo(0, 0);
            }
          }

          document.documentElement.removeAttribute('data-mp-navigating');
        });
      })
      .catch(function (err) {
        document.documentElement.removeAttribute('data-mp-navigating');
        if (err && err.name === 'AbortError') return; // superseded by newer navigation
        window.location.href = url;
      });
  }

  // Clean up listeners from any previous execution of this script
  // (runScripts() can re-execute this IIFE after a full-body swap).
  if (window.__mpRouterClickFn) {
    document.removeEventListener('click', window.__mpRouterClickFn, true);
  }
  if (window.__mpRouterPopFn) {
    window.removeEventListener('popstate', window.__mpRouterPopFn);
  }

  window.__mpRouterClickFn = function (e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (a.target === '_blank') return;
    if (a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || !href.startsWith(SCOPE)) return;
    // Same-pathname hash link: let the browser scroll natively
    var target = new URL(href, window.location.href);
    if (target.pathname === window.location.pathname && target.hash) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(href);
  };

  window.__mpRouterPopFn = function () {
    navigate(window.location.href, false);
  };

  document.addEventListener('click', window.__mpRouterClickFn, true);
  window.addEventListener('popstate', window.__mpRouterPopFn);
}());
</script>`.trim();
}

/**
 * Inline script block injected into every marketplace page.
 * Handles theme persistence and closes the app-switcher on outside clicks.
 */
export const chromeScript = `
<script>
(function() {
  // ── Theme ──
  var saved = localStorage.getItem('mp-theme');
  if (saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  window.toggleTheme = function() {
    var isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('mp-theme', isDark ? 'dark' : 'light');
  };

  // ── App-switcher: close on outside click ──
  document.addEventListener('click', function(e) {
    var sw = document.getElementById('mp-app-switcher');
    if (sw && !sw.contains(e.target)) sw.classList.remove('open');
  });
})();
</script>`.trim();

/**
 * Inline <style> block injected into every marketplace HTML page.
 *
 * @tailwindcss/vite strips custom element selectors (wf-html, wf-document)
 * and functional pseudo-classes (:host(.dark)) during its CSS optimisation
 * pass, making it impossible to target shadow DOM elements via the external
 * style.css file alone.  Injecting these rules as an inline <style> tag
 * places them inside the shadow root's stylesheet scope, where they work
 * correctly without going through the Tailwind pipeline.
 *
 * Rules here:
 *  - wf-html, wf-document: explicit variable declarations so shadow-root
 *    elements have all design tokens directly (belt-and-suspenders — :root
 *    and :host in style.css already cover inheritance, but direct assignment
 *    avoids any edge-case inheritance breaks).
 *  - :host(.dark): dark-mode override for when the consuming app adds the
 *    .dark class to the shadow host (<web-fragment-host>) rather than to an
 *    element inside the shadow tree itself.
 */
export const shadowCompatStyle = `
<style>
wf-html,wf-document{--color-absa-25:#fdf8f9;--color-absa-50:#f8eaee;--color-absa-100:#f0d0da;--color-absa-400:#d4547a;--color-absa-500:#af144b;--color-absa-600:#93103f;--color-absa-950:#1b0e12;--font-sans:Inter,"Noto Sans",ui-sans-serif,system-ui,sans-serif;--font-mono:"SF Mono","Fira Code","Fira Mono",ui-monospace,monospace;--bg-page:#fdf8f9;--bg-card:#fff;--bg-strong:oklch(98.5% .002 247.839);--bg-subtle:oklch(96.7% .003 264.542);--border:oklch(92.8% .006 264.531);--border-subtle:#f3e7eb;--text-heading:#1b0e12;--text-body:oklch(44.6% .03 256.802);--text-muted:oklch(55.1% .027 264.364);--text-hint:oklch(70.7% .022 261.325);--shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow-md:0 4px 12px rgba(0,0,0,.08);--shadow-lg:0 8px 24px rgba(0,0,0,.12);--radius-sm:6px;--radius-md:12px;--radius-lg:16px;--radius-xl:20px;--transition:.2s;--mp-chrome-h:56px}
:host(.dark),wf-html.dark{--bg-page:#0a0d14;--bg-card:#111827;--bg-strong:#1f2937;--bg-subtle:#1a2236;--border:#1f2937;--border-subtle:#1a2236;--text-heading:#fff;--text-body:#d1d5db;--text-muted:#9ca3af;--text-hint:#6b7280;--shadow-sm:0 1px 2px rgba(0,0,0,.3);--shadow-md:0 4px 12px rgba(0,0,0,.4);--shadow-lg:0 8px 24px rgba(0,0,0,.5)}
</style>`.trim();

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function appIconSvg(icon, size = 18) {
  const s = size;
  const icons = {
    'book-open':     `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    'cube':          `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
    'chip':          `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="6" height="6"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M19 9h3M2 15h3M19 15h3"/><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`,
    'chart-bar':     `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>`,
    'shield':        `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    'cog':           `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    'terminal':      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    'globe':         `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    'layers':        `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    'lightning-bolt':`<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    'document':      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    'collection':    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="5" rx="1"/><rect x="2" y="10" width="20" height="5" rx="1"/><rect x="2" y="17" width="20" height="5" rx="1"/></svg>`,
    'puzzle':        `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.2 6.8A4.5 4.5 0 0 0 16 2a4.5 4.5 0 0 0-4 2.4A4.5 4.5 0 0 0 8 2a4.5 4.5 0 0 0-4.2 4.8A4.5 4.5 0 0 0 2 11a4.5 4.5 0 0 0 2.4 4A4.5 4.5 0 0 0 2 19a4.5 4.5 0 0 0 4.8 4.2A4.5 4.5 0 0 0 11 26a4.5 4.5 0 0 0 4-2.4 4.5 4.5 0 0 0 4 2.4A4.5 4.5 0 0 0 24 20a4.5 4.5 0 0 0-2.4-4 4.5 4.5 0 0 0 2.4-4 4.5 4.5 0 0 0-3.8-5.2z"/></svg>`,
    'database':      `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>`,
  };
  return icons[icon] ?? icons['book-open'];
}
