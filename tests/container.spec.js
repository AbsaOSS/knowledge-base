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
    expect(await res.text()).toContain('data-mp-headless');
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
  test('the fragment-prefixed marketplace stylesheet resolves', async ({ request }) => {
    const res = await request.get('/__wf/knowledge-base/style.css');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');
  });

  test('the marketplace stylesheet also resolves under the normal prefix', async ({ request }) => {
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

  test('knowledge-base responses carry Cache-Control: no-transform', async ({ request }) => {
    // Stops an intermediate proxy (the FragmentGateway) re-encoding the body and
    // leaking a Content-Encoding header the browser then fails to decode.
    const res = await request.get('/knowledge-base/');
    expect(res.headers()['cache-control']).toContain('no-transform');
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
