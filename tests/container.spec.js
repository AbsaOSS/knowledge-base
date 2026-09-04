/**
 * tests/container.spec.js
 *
 * Integration tests against the real production image — nginx serving dist/,
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

  test('knowledge-base responses carry Cache-Control: no-transform', async ({ request }) => {
    // Stops an intermediate proxy (the FragmentGateway) re-encoding the body and
    // leaking a Content-Encoding header the browser then fails to decode.
    const res = await request.get('/knowledge-base/');
    expect(res.headers()['cache-control']).toContain('no-transform');
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

  test('the shipped nginx config is valid', () => {
    const out = execFileSync('docker', ['exec', CONTAINER, 'nginx', '-t'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(out + '').toBeDefined();
  });
});
