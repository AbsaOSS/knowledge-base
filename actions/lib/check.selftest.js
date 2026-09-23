/**
 * check.selftest.js — `npm run selftest:check` inside actions/.
 *
 * Pins every rule the checker reports: a clean site produces no finding at all,
 * each violation produces exactly the rule it breaks, and look-alikes that are
 * not violations (markup quoted in prose, a data block, an article header, an
 * image on a CDN) produce nothing. Then the CLI, and last the catalogue itself:
 * contract/RULES.md and rules.js must list the same IDs, titles and severities,
 * because the IDs are what a repo author searches for.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkApp } from './check.js';
import { RULES } from './rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'check-cli.js');
const RULES_MD = join(__dirname, '..', '..', 'contract', 'RULES.md');

const root = mkdtempSync(join(tmpdir(), 'kb-check-'));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${err.message}`);
  }
}

const APP = { slug: 'demo', name: 'Demo', description: 'Demo docs.' };

/** A compliant page; `head` and `body` are spliced in. */
function page({ head = '', body = '', html = 'lang="en" data-kb-headless="true"', bodyAttrs = '' } = {}) {
  return `<!doctype html>
<html ${html}>
<head><meta charset="utf-8"><title>T</title><link rel="stylesheet" href="assets/site.css">${head}</head>
<body${bodyAttrs}><main id="content"><h1>T</h1>${body}</main></body>
</html>
`;
}

/** Writes a site into a fresh directory and returns its findings. */
function site(name, files, app = APP) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries({ 'assets/site.css': '.doc { color: #333 }', ...files })) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return checkApp(dir, app);
}

const ids = (findings) => findings.map((f) => f.id).sort();

/** Asserts a site produces exactly these rule IDs. */
function expectIds(findings, expected) {
  assert.deepEqual(ids(findings), [...expected].sort(), JSON.stringify(findings, null, 2));
}

console.log('Clean output');

check('a compliant site produces no finding at all', () => {
  expectIds(site('clean', {
    'index.html': page({
      head: '<script src="assets/app.js" defer></script><script type="application/ld+json">{"a":1}</script>',
      body:
        '<article><header><h2>Section</h2></header></article>' +
        '<p>Write <code>&lt;base href="/"&gt;</code> or <code>onclick="x()"</code> in prose freely.</p>' +
        '<a href="guide/">Guide</a> <a href="guide/index.html#top">Top</a> <a href="#intro">Intro</a>' +
        '<a href="https://example.com/report.pdf">External PDF</a> <a href="mailto:a@b.c">Mail</a>' +
        '<img src="https://cdn.example.com/logo.png"> <link rel="icon" href="/favicon.ico">',
    }),
    'guide/index.html': page(),
    'assets/app.js': 'fetch(new URL("data.json", import.meta.url)); fetch("/api/x"); fetch(`${base}/y`);' +
      's.open("GET","function"==typeof e?e(n):e,!0);',
  }), []);
});

console.log('\nManifest and artifact');

check('KB-ART-001: a missing entry point', () => {
  expectIds(site('no-entry', { 'other.html': page() }), ['KB-ART-001']);
});

check('KB-ART-002: a pages entry that is not in the output', () => {
  const app = { ...APP, pages: [{ title: 'Gone', path: 'gone/index.html', order: 1 }] };
  expectIds(site('gone-page', { 'index.html': page() }, app), ['KB-ART-002']);
});

check('KB-ART-003: no HTML at all', () => {
  expectIds(site('no-html', { 'readme.txt': 'x' }, { ...APP, entryPoint: 'readme.txt' }), ['KB-ART-003']);
});

console.log('\nHTML');

check('KB-HTML-001: a page without the headless marker, and the legacy marker by name', () => {
  const missing = site('no-marker', { 'index.html': page({ html: 'lang="en"' }) });
  expectIds(missing, ['KB-HTML-001']);
  assert.match(missing[0].message, /missing data-kb-headless/);
  const legacy = site('legacy-marker', { 'index.html': page({ html: 'data-mp-headless="true"' }) });
  assert.match(legacy[0].message, /data-mp-headless.*pre-v1/);
});

check('KB-HTML-002: a <base> element', () => {
  expectIds(site('base', { 'index.html': page({ head: '<base href="/docs/">' }) }), ['KB-HTML-002']);
});

check('KB-HTML-003: root-relative URLs, named with an example', () => {
  const f = site('root-relative', { 'index.html': page({ body: '<img src="/images/logo.png"><a href="/guide/">G</a>' }) });
  expectIds(f, ['KB-HTML-003']);
  assert.match(f[0].message, /2 root-relative URL\(s\), e\.g\. "\/images\/logo\.png"/);
});

check('KB-HTML-004: an executable inline script, not a data block', () => {
  expectIds(site('inline', { 'index.html': page({ body: '<script>console.log(1)</script><script type="importmap">{}</script>' }) }), ['KB-HTML-004']);
});

check('KB-HTML-005: an inline event handler', () => {
  const f = site('handler', { 'index.html': page({ body: '<button onclick="go()">Go</button>' }) });
  expectIds(f, ['KB-HTML-005']);
  assert.match(f[0].message, /<button onclick>/);
});

check('KB-HTML-006: a javascript: URL', () => {
  expectIds(site('js-url', { 'index.html': page({ body: '<a href="javascript:void(0)">x</a>' }) }), ['KB-HTML-006']);
});

check('KB-HTML-007: a <header> directly inside <body>, not one inside the content', () => {
  const html = page().replace('<body>', '<body><header class="fixed top-0"><a href="./">Logo</a></header>');
  expectIds(site('site-header', { 'index.html': html }), ['KB-HTML-007']);
});

check('KB-HTML-008: a link to a non-HTML file in the app', () => {
  const f = site('download', { 'index.html': page({ body: '<a href="files/spec.pdf">Spec</a><a href="img/big.png?v=2">Big</a>' }) });
  expectIds(f, ['KB-HTML-008']);
  assert.match(f[0].message, /2 link\(s\).*"files\/spec\.pdf"/);
});

console.log('\nCSS, theme, CSP, JavaScript');

check('KB-CSS-001: !important in a stylesheet file and in an inline <style>', () => {
  const f = site('important', {
    'index.html': page({ head: '<style>h1 { color: red !important }</style>' }),
    'assets/site.css': 'a { color: blue !important; } p { margin: 0 !important }',
  });
  expectIds(f, ['KB-CSS-001', 'KB-CSS-001']);
  assert.ok(f.some((x) => x.where === 'demo/assets/site.css' && /^2 !important/.test(x.message)), JSON.stringify(f));
});

check('KB-THEME-001: a theme bootstrap script, and a dark class', () => {
  const bootstrap = "if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');";
  expectIds(site('theme-script', { 'index.html': page({ head: `<script>${bootstrap}</script>` }) }), ['KB-HTML-004', 'KB-THEME-001']);
  expectIds(site('theme-class', { 'index.html': page({ bodyAttrs: ' class="docs dark"' }) }), ['KB-THEME-001']);
});

check('KB-CSP-001: scripts, stylesheets and fonts from another origin', () => {
  const f = site('csp', {
    'index.html': page({ head: '<script src="https://cdn.example.com/x.js"></script><link rel="stylesheet" href="//cdn.example.com/x.css">' }),
    'assets/site.css': "@import url('https://fonts.googleapis.com/css2?family=Inter');\n" +
      "@font-face { font-family: X; src: url(https://cdn.example.com/x.woff2) format('woff2'); }",
  });
  expectIds(f, ['KB-CSP-001', 'KB-CSP-001']);
});

check('KB-JS-001: a page-relative fetch in a file and in an inline script', () => {
  const f = site('fetch', {
    'index.html': page({ body: "<script>fetch('search.json')</script>" }),
    'assets/app.js': "const x = new XMLHttpRequest(); x.open('GET', 'data/index.json');",
  });
  expectIds(f, ['KB-HTML-004', 'KB-JS-001', 'KB-JS-001']);
});

console.log('\nCLI');

function cli(dir, ...args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

function workspace(name, files) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'kb-docs.json'), JSON.stringify({ kbVersion: '1', apps: [APP] }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, 'dist', dirname(rel)), { recursive: true });
    writeFileSync(join(dir, 'dist', rel), content);
  }
  return dir;
}

check('exits 0 on warnings only, 1 under --strict, and prints rule IDs', () => {
  const dir = workspace('cli-warn', { 'index.html': page({ body: '<script>1</script>' }) });
  const plain = cli(dir);
  assert.equal(plain.code, 0, plain.out);
  assert.match(plain.out, /warning KB-HTML-004 demo\/index\.html:/);
  assert.match(plain.out, /contract\/RULES\.md/);
  assert.equal(cli(dir, '--strict').code, 1);
});

check('exits 1 on an error, and --json is machine-readable', () => {
  const dir = workspace('cli-error', { 'index.html': page({ html: 'lang="en"' }) });
  const { code, out } = cli(dir, '--json');
  assert.equal(code, 1);
  const findings = JSON.parse(out);
  assert.deepEqual(findings.map((f) => [f.id, f.severity, f.where]), [['KB-HTML-001', 'error', 'demo/index.html']]);
});

check('reports a broken manifest as KB-MAN-001 instead of crashing', () => {
  const dir = workspace('cli-manifest', { 'index.html': page() });
  writeFileSync(join(dir, 'kb-docs.json'), '{ not json');
  const { code, out } = cli(dir);
  assert.equal(code, 1);
  assert.match(out, /error {3}KB-MAN-001 kb-docs\.json: .*not valid JSON/);
});

console.log('\nCatalogue');

check('contract/RULES.md and rules.js list the same rules, titles and severities', () => {
  const md = readFileSync(RULES_MD, 'utf8');
  const documented = {};
  for (const m of md.matchAll(/^### (KB-[A-Z]+-\d{3}) — (.+)\n\n\*\*Severity:\*\* (error|warning)$/gm)) {
    documented[m[1]] = { severity: m[3], title: m[2].replace(/`/g, '') };
  }
  const coded = Object.fromEntries(Object.entries(RULES).map(([id, r]) => [id, { severity: r.severity, title: r.title }]));
  assert.deepEqual(documented, coded);

  const indexed = [...md.matchAll(/^\| \[(KB-[A-Z]+-\d{3})\]\(#[^)]+\) \| (error|warning) \|/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(indexed, Object.entries(RULES).map(([id, r]) => [id, r.severity]), 'the index table is out of step');
});

check('every rule the checker can report is in the catalogue', () => {
  const sources = ['check.js', 'check-cli.js', 'manifest.js', 'pack.js'].map((f) => readFileSync(join(__dirname, f), 'utf8')).join('\n');
  const used = new Set(sources.match(/KB-[A-Z]+-\d{3}/g));
  for (const id of used) assert.ok(RULES[id], `${id} is reported but not in rules.js`);
  for (const id of Object.keys(RULES)) assert.ok(used.has(id), `${id} is in rules.js but nothing reports it`);
});

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\nAll checks passed');
