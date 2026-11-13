/**
 * tests/container.spec.js
 *
 * Integration tests against the real production images — nginx serving dist/
 * and proxying /knowledge-base/mcp to the MCP server container beside it —
 * driven through playwright.config.docker.js.
 *
 * Everything here is a claim that only the actual nginx.conf can settle:
 * location precedence, internal rewrites, `add_header` inheritance, and the
 * container's own runtime posture. The other two suites run against
 * tests/fragment-server.mjs, an Express mirror — useful and fast, but it is a
 * second implementation of the same contract and it has drifted twice (#45,
 * #60). This file is the one that reads the shipped config.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const CONTAINER = 'kb-container-test';
const MCP_CONTAINER = 'kb-container-test-mcp';
const PORT = process.env.KB_CONTAINER_PORT || '8099';
const SITE_ORIGIN = `http://localhost:${PORT}`;

/** The set nginx.headers.conf defines and every location block must include. */
const SHARED_HEADERS = {
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin',
};

// ─────────────────────────────────────────────────────────────────────────────
// Routing contract
// ─────────────────────────────────────────────────────────────────────────────

test.describe('routing', () => {
  test('healthz responds 200 as plain text', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');
    expect((await res.text()).trim()).toBe('ok');
  });

  test('the landing catalog is served', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
  });

  test('a packaged sub-app page is served', async ({ request }) => {
    const res = await request.get('/knowledge-base/user-guide/');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('data-kb-headless');
  });

  // The production-only rule. nginx.conf uses an INTERNAL rewrite here, not a
  // redirect, because a 301 would expose the container's internal HTTP address
  // to the browser and break mixed-content under HTTPS. The Express mirror sent
  // a 308 instead (#60) — this is the assertion that tells the two apart.
  test('/knowledge-base without a trailing slash is rewritten internally, not redirected', async ({ request }) => {
    const res = await request.get('/knowledge-base', { maxRedirects: 0 });
    expect(res.status(), 'a 3xx here leaks the internal container address').toBe(200);
    expect(res.headers()['location'], 'no Location header — this must not be a redirect').toBeUndefined();
    expect(res.headers()['content-type']).toContain('text/html');
  });

  // try_files $uri $uri/index.html — nginx serves a directory path as its index
  // with a 200 whether or not it has a trailing slash, and never redirects.
  // express.static does the opposite by default (301), which is what made the
  // mirror diverge; see tests/fragment-server.mjs.
  test('a sub-app page without a trailing slash is served, not redirected', async ({ request }) => {
    const res = await request.get('/knowledge-base/user-guide', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()['location']).toBeUndefined();
  });

  // Sub-app pages hardcode this path; the gateway/nginx rewrite is what makes it
  // resolve to dist/style.css. If it 404s, every sub-app page loses its styling.
  test('the fragment-prefixed knowledge base stylesheet resolves', async ({ request }) => {
    const res = await request.get('/__wf/knowledge-base/style.css');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');
  });

  test('the knowledge base stylesheet also resolves under the normal prefix', async ({ request }) => {
    const res = await request.get('/knowledge-base/style.css');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');
  });

  test('an unknown sub-app path is a 404, not the landing page', async ({ request }) => {
    const res = await request.get('/knowledge-base/no-such-app/');
    expect(res.status()).toBe(404);
  });

  test('an unknown top-level path is a 404', async ({ request }) => {
    const res = await request.get('/no-such-thing');
    expect(res.status()).toBe(404);
  });

  test('OPTIONS preflight is answered without hitting try_files', async ({ request }) => {
    const res = await request.fetch('/knowledge-base/', { method: 'OPTIONS' });
    expect(res.status()).toBe(204);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Header inheritance
//
// This is the #45 regression guard, asserted against the shipped config rather
// than against nginx.conf as text (tests/nginx-config.spec.js) or against a
// mirror that sends whatever it was told to (tests/standalone.spec.js).
// ─────────────────────────────────────────────────────────────────────────────

test.describe('response headers', () => {
  const paths = [
    ['the landing page', '/knowledge-base/'],
    ['a sub-app page', '/knowledge-base/user-guide/'],
    ['a static asset', '/knowledge-base/style.css'],
    ['a fragment-prefixed asset', '/__wf/knowledge-base/style.css'],
    ['the health endpoint', '/healthz'],
    ['the no-trailing-slash path', '/knowledge-base'],
  ];

  for (const [label, path] of paths) {
    test(`CORS and security headers reach ${label}`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      const headers = res.headers();
      for (const [name, value] of Object.entries(SHARED_HEADERS)) {
        expect(
          (headers[name] ?? '').toUpperCase(),
          `${name} missing on ${path} — a location block declaring add_header ` +
          'discards every inherited add_header unless it includes kb-headers.conf',
        ).toBe(value.toUpperCase());
      }
    });
  }

  test('X-Frame-Options is never DENY — it would block the web-fragments iframe', async ({ request }) => {
    for (const [, path] of paths) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect((res.headers()['x-frame-options'] ?? '').toUpperCase()).not.toBe('DENY');
    }
  });

  test('the deprecated X-XSS-Protection header is not sent', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    expect(res.headers()['x-xss-protection']).toBeUndefined();
  });

  // The CSP is the defence-in-depth half of #42, behind the publish-time
  // sanitiser. script-src with no 'unsafe-inline' is the part that matters, and
  // it only holds because nothing inline survives the build — see
  // tests/build-integrity.spec.js and scripts/hoist-inline-scripts.js.
  test('a Content-Security-Policy is served, with script-src locked down', async ({ request }) => {
    const res = await request.get('/knowledge-base/');
    const csp = res.headers()['content-security-policy'];
    expect(csp, 'no CSP header').toBeTruthy();

    const directives = Object.fromEntries(
      csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values.join(' ')];
      }),
    );

    expect(directives['script-src']).toBe("'self'");
    expect(directives['script-src'], "'unsafe-inline' would let an injected script run")
      .not.toContain('unsafe-inline');
    expect(directives['script-src'], "'unsafe-eval' is not needed by anything here")
      .not.toContain('unsafe-eval');
    expect(directives['object-src']).toBe("'none'");
    expect(directives['base-uri'], 'a <base> tag can redirect every relative URL').toBe("'none'");
    expect(directives['default-src']).toBe("'self'");
    expect(directives['frame-ancestors']).toBe("'self'");
  });

  test('the CSP reaches static assets too, not just pages', async ({ request }) => {
    const res = await request.get('/knowledge-base/style.css');
    expect(res.headers()['content-security-policy']).toBeTruthy();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Caching policy per asset class
//
// Both prefixes are ^~ locations, which skip regex locations — a policy set
// anywhere but inside them is never reached. Only the real nginx settles that.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('caching', () => {
  const IMMUTABLE = /^public, max-age=31536000, immutable, no-transform$/;
  const REVALIDATE = /^no-cache, no-transform$/;

  /** A URL of each immutable class, taken from what the pages actually reference. */
  async function hashedUrls(request) {
    const landing = await (await request.get('/knowledge-base/')).text();
    const astro = landing.match(/(?:src|href)="(\/knowledge-base\/_astro\/[^"]+)"/)?.[1];
    const admin = await (await request.get('/knowledge-base/user-guide/admin/')).text();
    const inline = admin.match(/src="(\/knowledge-base\/user-guide\/_kb-inline\/[0-9a-f]{16}\.js)"/)?.[1];
    expect(astro, 'the landing page references no _astro/ asset').toBeTruthy();
    expect(inline, 'user-guide/admin references no hoisted script').toBeTruthy();
    return { astro, inline };
  }

  test('hashed assets are cached for a year as immutable, under both prefixes', async ({ request }) => {
    const { astro, inline } = await hashedUrls(request);
    for (const path of [astro, inline, astro.replace(/^\//, '/__wf/'), inline.replace(/^\//, '/__wf/')]) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()['cache-control'], path).toMatch(IMMUTABLE);
    }
  });

  // style.css is the one knowledge base asset that cannot be content-addressed:
  // external consumers fetch it by that name. Immutable would pin a stale copy
  // for a year after a deploy.
  for (const [label, path] of [
    ['the landing page', '/knowledge-base/'],
    ['a sub-app page', '/knowledge-base/user-guide/'],
    ['the no-trailing-slash path', '/knowledge-base'],
    ['style.css', '/knowledge-base/style.css'],
    ['fragment-prefixed style.css', '/__wf/knowledge-base/style.css'],
    ['a sub-app asset with a stable name', '/knowledge-base/user-guide/docs/style.css'],
  ]) {
    test(`${label} is revalidated on every use`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toMatch(REVALIDATE);
    });
  }

  test('a missing hashed asset is not cached as immutable', async ({ request }) => {
    const res = await request.get('/knowledge-base/_astro/no-such-file.DEADBEEF.js');
    expect(res.status()).toBe(404);
    expect(res.headers()['cache-control'] ?? '').not.toContain('immutable');
  });

  test('an unchanged asset revalidates to a 304', async ({ request }) => {
    const first = await request.get('/knowledge-base/style.css');
    const etag = first.headers()['etag'];
    expect(etag, 'nginx sends an ETag for static files').toBeTruthy();
    const again = await request.get('/knowledge-base/style.css', { headers: { 'If-None-Match': etag } });
    expect(again.status()).toBe(304);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The CSP in a real browser
//
// Asserting the header is not the same as asserting the page still works under
// it. A CSP that blocks something the page needs fails silently — no error
// status, no failed request in a header check, just a page that quietly stopped
// doing part of its job. Only a browser reports the violation.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('CSP in a browser', () => {
  const pages = [
    ['the landing catalog', '/knowledge-base/'],
    ['a packaged sub-app page', '/knowledge-base/user-guide/'],
    ['a single-page doc with a diagram', '/knowledge-base/platform-overview/'],
    ['a single-page doc without one', '/knowledge-base/release-process/'],
  ];

  for (const [label, path] of pages) {
    test(`${label} loads with no CSP violation`, async ({ page }) => {
      const violations = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(text)) {
          violations.push(text);
        }
      });
      page.on('pageerror', (err) => violations.push(`page error: ${err.message}`));

      await page.goto(path, { waitUntil: 'networkidle' });

      expect(violations, `CSP blocked something on ${path}`).toEqual([]);
      // A blocked stylesheet or script often still leaves a rendered body, so
      // assert the masthead specifically — it is the one thing every page has.
      await expect(page.locator('header, [class*="masthead"]').first()).toBeVisible();
    });
  }

  // The fixture ships the real mermaid bundle the action vendors; a diagram
  // that stays source text is the silent failure this policy could cause.
  test('a mermaid diagram renders to SVG under the policy', async ({ page }) => {
    await page.goto('/knowledge-base/platform-overview/');
    const diagram = page.locator('main.kb-single-page pre.mermaid').first();
    await expect(diagram.locator('svg')).toBeVisible({ timeout: 15_000 });
    await expect(diagram).not.toContainText('flowchart LR');
  });

  test('the hoisted sub-app scripts actually execute under the policy', async ({ page }) => {
    const blocked = [];
    page.on('response', (res) => {
      if (res.url().includes('_kb-inline') && !res.ok()) blocked.push(`${res.status()} ${res.url()}`);
    });
    const loaded = [];
    page.on('request', (req) => {
      if (req.url().includes('_kb-inline')) loaded.push(req.url());
    });

    // A nested page, not the app index: the docs-example fixture's remaining
    // inline script lives on its admin page, and this also exercises the ../
    // depth computation in scripts/hoist-inline-scripts.js. (The fixture's other
    // inline script was its dark-mode bootstrap, which the build now deletes
    // rather than hoisting — see #48.)
    await page.goto('/knowledge-base/user-guide/admin/', { waitUntil: 'networkidle' });

    expect(loaded.length, 'no hoisted script was requested — did the hoist step run?').toBeGreaterThan(0);
    expect(blocked, 'a hoisted script failed to load').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The MCP endpoint, through nginx
//
// nginx owns the generic limits (rate, body size), the MCP server the protocol
// checks (Origin, Host) and CORS. Only the real pair settles how they combine:
// the in-process Python tests never see nginx, and nginx.config.spec.js only
// reads the config. Serial, so the rate-limit test runs last and alone.
// ─────────────────────────────────────────────────────────────────────────────

test.describe('MCP endpoint', () => {
  test.describe.configure({ mode: 'serial' });

  const ENDPOINT = '/knowledge-base/mcp';
  const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
  const INITIALIZE = rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'container-test', version: '1' },
  });

  test('an agent can initialize through nginx', async ({ request }) => {
    const res = await request.post(ENDPOINT, { headers: JSON_HEADERS, data: INITIALIZE });
    expect(res.status()).toBe(200);
    expect((await res.json()).result.serverInfo.name).toBe('knowledge-base');
    expect(res.headers()['cache-control']).toBe('no-store');
  });

  test('search finds the fixture docs and links them on the public origin', async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: JSON_HEADERS,
      data: rpc('tools/call', { name: 'search_documents', arguments: { query: 'release' } }),
    });
    expect(res.status()).toBe(200);
    const { structuredContent } = (await res.json()).result;
    expect(structuredContent.total).toBeGreaterThan(0);
    for (const hit of structuredContent.results) {
      expect(hit.url).toMatch(new RegExp(`^${SITE_ORIGIN}/knowledge-base/`));
    }
  });

  test('a browser opening the endpoint gets the explanation page, with the security headers', async ({ request }) => {
    const res = await request.get(ENDPOINT);
    expect(res.status()).toBe(405);
    expect(res.headers()['allow']).toBe('POST');
    expect(await res.text()).toContain(`${SITE_ORIGIN}${ENDPOINT}`);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['content-security-policy']).toBeTruthy();
  });

  test('CORS comes from the MCP server alone, for its allowed origins', async ({ request }) => {
    const preflight = await request.fetch(ENDPOINT, {
      method: 'OPTIONS',
      headers: {
        Origin: SITE_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status(), 'answered by the MCP server, not the static 204').toBe(200);
    expect(preflight.headersArray().filter((h) => h.name.toLowerCase() === 'access-control-allow-origin'))
      .toEqual([{ name: expect.any(String), value: SITE_ORIGIN }]);

    const call = await request.post(ENDPOINT, { headers: { ...JSON_HEADERS, Origin: SITE_ORIGIN }, data: INITIALIZE });
    expect(call.status()).toBe(200);
    expect(call.headers()['access-control-allow-origin']).toBe(SITE_ORIGIN);
  });

  test('a page from another origin is refused', async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: { ...JSON_HEADERS, Origin: 'https://evil.example' },
      data: INITIALIZE,
    });
    expect(res.status()).toBe(403);
  });

  test('a body over 64 KiB is refused by nginx', async ({ request }) => {
    const res = await request.post(ENDPOINT, {
      headers: JSON_HEADERS,
      data: rpc('tools/call', { name: 'search_documents', arguments: { query: 'x'.repeat(70 * 1024) } }),
    });
    expect(res.status()).toBe(413);
  });

  test('a burst beyond the per-client limit is answered 429', async ({ request }) => {
    const statuses = await Promise.all(
      Array.from({ length: 80 }, () => request.post(ENDPOINT, { headers: JSON_HEADERS, data: INITIALIZE })
        .then((res) => res.status())),
    );
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status !== 200 && status !== 429)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Container posture
// ─────────────────────────────────────────────────────────────────────────────

test.describe('container', () => {
  test('nginx does not run as root', () => {
    const id = execFileSync('docker', ['exec', CONTAINER, 'id'], { encoding: 'utf8' });
    expect(id, 'the image must run unprivileged — see the Dockerfile').toContain('uid=101(nginx)');

    const processes = execFileSync('docker', ['exec', CONTAINER, 'ps', '-o', 'user,comm'], { encoding: 'utf8' });
    const owners = processes.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/)[0]);
    expect(owners.filter((u) => u === 'root'), 'no nginx process may run as root').toEqual([]);
  });

  test('the MCP server does not run as root', () => {
    const id = execFileSync('docker', ['exec', MCP_CONTAINER, 'id', '-u'], { encoding: 'utf8' });
    expect(id.trim()).not.toBe('0');
  });

  test('the shipped nginx config is valid', () => {
    const out = execFileSync('docker', ['exec', CONTAINER, 'nginx', '-t'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(out + '').toBeDefined();
  });
});
