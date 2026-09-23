/**
 * selftest.js — `npm run selftest:check-docs` inside actions/.
 *
 * Runs the real entry point over sample workspaces, the way the composite
 * action does (cwd = workspace, relative paths), with the runner's output and
 * summary files faked. What a docs repo sees on its pull request is the
 * subject: the exit status, one annotation per rule, and a job summary that
 * lists every finding. The rules themselves are pinned by lib/check.selftest.js.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'index.js');

const root = mkdtempSync(join(tmpdir(), 'kb-check-docs-'));
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

const MANIFEST = { kbVersion: '1', apps: [{ slug: 'demo', name: 'Demo', description: 'Demo docs for the self-test.' }] };

function page(body = '', html = 'lang="en" data-kb-headless="true"') {
  return `<!doctype html><html ${html}><head><meta charset="utf-8"><title>T</title></head><body><main>${body}</main></body></html>\n`;
}

/** A workspace with a manifest (or none) and a built site under dist/. */
function workspace(name, files, manifest = MANIFEST) {
  const ws = join(root, name);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ws, 'dist'), { recursive: true });
  if (manifest) writeFileSync(join(ws, 'kb-docs.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(ws, 'dist', dirname(rel)), { recursive: true });
    writeFileSync(join(ws, 'dist', rel), content);
  }
  return ws;
}

/** Runs the action body in `ws`; returns exit code, stdout, outputs and summary. */
function action(ws, env = {}) {
  const out = join(ws, '.github-output');
  const sum = join(ws, '.github-summary');
  writeFileSync(out, '');
  writeFileSync(sum, '');
  let code = 0;
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [ENTRY], {
      cwd: ws,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, KB_MANIFEST: '', KB_DIST: '', KB_CHECK_STRICT: '', ...env },
    });
  } catch (err) {
    code = err.status;
    stdout = err.stdout;
  }
  const outputs = Object.fromEntries(
    [...readFileSync(out, 'utf8').matchAll(/^(\w+)<<(\S+)\n([\s\S]*?)\n\2$/gm)].map((m) => [m[1], m[3]]),
  );
  return { code, stdout, outputs, summary: readFileSync(sum, 'utf8') };
}

console.log('check-docs');

check('a clean site passes, with zero counts and a summary that says so', () => {
  const r = action(workspace('clean', { 'index.html': page() }));
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.outputs, { errors: '0', warnings: '0' });
  assert.match(r.summary, /0 error\(s\), 0 warning\(s\)/);
  assert.match(r.summary, /No findings/);
  assert.doesNotMatch(r.stdout, /::(error|warning)/);
});

check('warnings pass, with one annotation per rule, not one per page', () => {
  const r = action(workspace('warnings', {
    'index.html': page('<script>a()</script>'),
    'guide/index.html': page('<script>b()</script>'),
  }));
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(r.outputs, { errors: '0', warnings: '2' });
  const annotations = r.stdout.match(/^::warning title=KB-HTML-004::.*$/gm) ?? [];
  assert.equal(annotations.length, 1, r.stdout);
  assert.match(annotations[0], /KB-HTML-004 ×2, e\.g\. demo\//);
});

check('the job summary tables every rule and lists every finding', () => {
  const r = action(workspace('summary', {
    'index.html': page('<script>a()</script><button onclick="x()">x|y</button>'),
    'guide/index.html': page('<script>b()</script>'),
  }));
  assert.match(r.summary, /\| KB-HTML-004 \| warning \| 2 \|/);
  assert.match(r.summary, /\| KB-HTML-005 \| warning \| 1 \|/);
  assert.match(r.summary, /All 3 finding\(s\)/);
  assert.match(r.summary, /contract\/RULES\.md\]\(https:\/\/github\.com\/AbsaOSS\/knowledge-base\/blob\/master\/contract\/RULES\.md\)/);
});

check('strict fails on warnings', () => {
  const ws = workspace('strict', { 'index.html': page('<script>a()</script>') });
  const r = action(ws, { KB_CHECK_STRICT: 'true' });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /::error::1 warning finding\(s\), and "strict" is on/);
  assert.match(r.summary, /The check fails \(strict: warnings fail too\)/);
});

check('an error fails the check, annotated as an error with its rule', () => {
  const r = action(workspace('error', { 'index.html': page('', 'lang="en"') }));
  assert.equal(r.code, 1);
  assert.equal(r.outputs.errors, '1');
  assert.match(r.stdout, /^::error title=KB-HTML-001::KB-HTML-001 demo\/index\.html: missing data-kb-headless/m);
  assert.match(r.stdout, /::error::1 error finding\(s\): the publish-docs action would refuse this output/);
});

check('a missing manifest is a KB-MAN-001 finding, named as the user wrote it', () => {
  const r = action(workspace('no-manifest', { 'index.html': page() }, null));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^::error title=KB-MAN-001::KB-MAN-001 kb-docs\.json: No manifest at/m);
});

check('custom manifest and dist inputs are honoured, relative to the workspace', () => {
  const ws = workspace('custom', {});
  mkdirSync(join(ws, 'docs-meta'), { recursive: true });
  writeFileSync(join(ws, 'docs-meta', 'kb.json'), JSON.stringify(MANIFEST));
  mkdirSync(join(ws, 'site'), { recursive: true });
  writeFileSync(join(ws, 'site', 'index.html'), page());
  const r = action(ws, { KB_MANIFEST: 'docs-meta/kb.json', KB_DIST: 'site' });
  assert.equal(r.code, 0, r.stdout);
  const missing = action(ws, { KB_MANIFEST: 'docs-meta/kb.json', KB_DIST: 'build' });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /KB-ART-001 build: the built output directory does not exist/);
});

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n\x1b[31m${failures} check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log('\nAll checks passed');
