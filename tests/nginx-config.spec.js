/**
 * tests/nginx-config.spec.js
 *
 * Static checks on nginx.conf itself (no server, no browser).
 *
 * nginx's `add_header` does not merge across configuration levels: a block that
 * declares any add_header discards every add_header inherited from its parent.
 * That makes "add a Cache-Control to this location" a one-line change that
 * silently strips CORS and every security header from those responses — which
 * is exactly what had happened.
 *
 * The E2E suites cannot catch it: they run against tests/fragment-server.mjs,
 * an Express mirror of the nginx *rewrites*, and no nginx is started anywhere in
 * CI. So the config is asserted as text instead.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONF = readFileSync(join(ROOT, 'nginx.conf'), 'utf8');
const HEADERS_CONF = readFileSync(join(ROOT, 'nginx.headers.conf'), 'utf8');

const INCLUDE = 'include /etc/nginx/kb-headers.conf;';

/**
 * Splits nginx.conf into its `location` blocks by brace depth.
 * Good enough for this file, which has no nested locations.
 */
function locationBlocks(conf) {
  const blocks = [];
  const re = /location\s+([^{]+?)\s*\{/g;
  let match;
  while ((match = re.exec(conf)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < conf.length && depth > 0) {
      if (conf[i] === '{') depth++;
      else if (conf[i] === '}') depth--;
      i++;
    }
    blocks.push({ selector: match[1].trim(), body: conf.slice(re.lastIndex, i - 1) });
  }
  return blocks;
}

/**
 * Strips `#` comments so assertions never match commentary.
 * `.` does not match `\r`, so a CRLF checkout (the default on Windows, where
 * there is no .gitattributes to force LF) needs the line ending trimmed first.
 */
const uncomment = (text) =>
  text.split('\n').map((l) => l.replace(/\r$/, '').replace(/#.*$/, '')).join('\n');

test.describe('nginx.conf header inheritance', () => {
  test('the shared header set is defined once, in nginx.headers.conf', () => {
    const shared = uncomment(HEADERS_CONF);
    for (const header of [
      'Access-Control-Allow-Origin',
      'Access-Control-Allow-Methods',
      'Access-Control-Allow-Headers',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
    ]) {
      expect(shared, `${header} must be in the shared snippet`).toContain(header);
      expect(uncomment(CONF), `${header} must not be redeclared in nginx.conf`).not.toContain(header);
    }
  });

  test('the server block includes the shared headers', () => {
    expect(uncomment(CONF)).toContain(INCLUDE);
  });

  test('every location that declares add_header also includes the shared headers', () => {
    const offenders = locationBlocks(uncomment(CONF))
      .filter((block) => /\badd_header\b/.test(block.body))
      .filter((block) => !block.body.includes(INCLUDE))
      .map((block) => block.selector);

    expect(
      offenders,
      'these location blocks declare add_header, which discards every inherited ' +
      'add_header — they must include /etc/nginx/kb-headers.conf as well',
    ).toEqual([]);
  });

  test('X-Frame-Options is not DENY — it would block the web-fragments iframe', () => {
    expect(uncomment(HEADERS_CONF)).toMatch(/X-Frame-Options\s+"SAMEORIGIN"/);
  });

  test('the deprecated X-XSS-Protection header is not set', () => {
    expect(uncomment(CONF) + uncomment(HEADERS_CONF)).not.toContain('X-XSS-Protection');
  });

  test('style-src and font-src allow no third-party origin', () => {
    // Inter is served from this origin (#54), so neither directive needs a host
    // allowlisted. Re-adding a CDN font would quietly widen the policy again.
    const csp = uncomment(HEADERS_CONF).match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/)?.[1] ?? '';
    for (const directive of ['style-src', 'font-src']) {
      const value = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(directive + ' ')) ?? '';
      expect(value, `no ${directive} in the policy`).toBeTruthy();
      expect(value, `${directive} allowlists an external origin`).not.toMatch(/https?:\/\//);
    }
  });

  // The Express mirror serves the same policy so the embedded harness exercises
  // it through the gateway. Two copies means they can drift, so the drift is
  // what gets asserted.
  test('the CSP in nginx.headers.conf matches the one the test mirror serves', () => {
    const nginxCsp = uncomment(HEADERS_CONF)
      .match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/)?.[1];
    expect(nginxCsp, 'no CSP in nginx.headers.conf').toBeTruthy();

    const mirror = readFileSync(join(ROOT, 'tests', 'fragment-server.mjs'), 'utf8');
    const mirrorCsp = mirror
      .match(/const CSP = \[([\s\S]*?)\]\.join\('; '\)/)?.[1]
      ?.split('\n')
      .map((l) => l.trim().replace(/^["']|["'],?$/g, ''))
      .filter(Boolean)
      .join('; ');

    expect(mirrorCsp, 'no CSP in tests/fragment-server.mjs').toBeTruthy();
    expect(mirrorCsp, 'the mirror and nginx must serve the same policy').toBe(nginxCsp);
  });

  test('both prefix locations set Cache-Control from the per-asset-class map', () => {
    // Every asset is served from one of these ^~ locations, and ^~ skips regex
    // locations — a caching policy anywhere else is never reached.
    const blocks = locationBlocks(uncomment(CONF));
    for (const selector of ['^~ /knowledge-base/', '^~ /__wf/knowledge-base/']) {
      const block = blocks.find((b) => b.selector === selector);
      expect(block, `${selector} location block`).toBeTruthy();
      expect(block.body).toMatch(/add_header\s+Cache-Control\s+\$kb_cache_control\s*;/);
      expect(block.body, 'without `always`: an error response must not be cached as immutable')
        .not.toMatch(/add_header\s+Cache-Control[^;]*\balways\b/);
    }
    const unreachable = blocks.filter((b) => /^~/.test(b.selector) && /Cache-Control|expires/.test(b.body));
    expect(unreachable.map((b) => b.selector), 'a regex location never runs under the ^~ prefixes').toEqual([]);
  });

  test('the cache map and the test mirror agree on every class', () => {
    const map = uncomment(CONF).match(/map\s+\$request_uri\s+\$kb_cache_control\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(map, 'no $kb_cache_control map in nginx.conf').toBeTruthy();
    const entries = [...map.matchAll(/^\s*("?)(\S+?)\1\s+"([^"]+)";/gm)].map((m) => [m[2], m[3]]);
    const nginxDefault = entries.find(([k]) => k === 'default')?.[1];
    const nginxImmutable = entries.filter(([k]) => k !== 'default');

    const mirror = readFileSync(join(ROOT, 'tests', 'fragment-server.mjs'), 'utf8');
    const constant = (name) => mirror.match(new RegExp(`const ${name} = '([^']+)'`))?.[1];
    const mirrorPatterns = [...(mirror.match(/const IMMUTABLE_PATHS = \[([\s\S]*?)\];/)?.[1] ?? '')
      .matchAll(/^\s*\/(.+)\/,\r?$/gm)].map((m) => m[1].replace(/\\\//g, '/'));

    expect(nginxDefault).toBe(constant('REVALIDATE'));
    expect(new Set(nginxImmutable.map(([, v]) => v))).toEqual(new Set([constant('IMMUTABLE')]));
    expect(nginxImmutable.map(([k]) => k.replace(/^~/, ''))).toEqual(mirrorPatterns);
    for (const policy of [nginxDefault, constant('IMMUTABLE')]) {
      expect(policy, 'the gateway must not re-encode any response').toContain('no-transform');
    }
  });

  test('healthz sets its content type with default_type, not a post-return add_header', () => {
    const healthz = locationBlocks(uncomment(CONF)).find((b) => b.selector === '= /healthz');
    expect(healthz, '/healthz location block').toBeTruthy();
    expect(healthz.body).toContain('default_type text/plain;');
    expect(healthz.body).not.toMatch(/add_header\s+Content-Type/);
  });
});

test.describe('Dockerfile', () => {
  const DOCKERFILE = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');

  test('runs an unprivileged nginx pinned by digest', () => {
    const from = DOCKERFILE.split('\n').find((l) => l.startsWith('FROM '));
    expect(from).toContain('nginx-unprivileged');
    expect(from, 'base image must be pinned by digest, like the GitHub Actions are')
      .toMatch(/@sha256:[a-f0-9]{64}/);
  });

  test('ships the shared header snippet the config includes', () => {
    expect(DOCKERFILE).toContain('nginx.headers.conf /etc/nginx/kb-headers.conf');
  });
});
