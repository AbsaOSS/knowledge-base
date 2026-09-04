/**
 * selftest.js — `npm run selftest:docs` inside actions/.
 *
 * Exercises publish-docs without a runner: builds a sample headless site in a
 * temp directory, runs the real entry point over it, and asserts what came out.
 *
 * The error messages are as much the subject as the happy path. This action is
 * the whole interface a docs repo has with the contract, so a message that does
 * not say which file is wrong and what to change costs somebody a CI round trip.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSET_NAME, MANIFEST, PublishError, buildManifest, readManifestFile } from '../../lib/manifest.js';
import { verifyApp } from '../../lib/verify-html.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, 'index.js');

const root = mkdtempSync(join(tmpdir(), 'kb-publish-docs-'));
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

/** A minimal compliant page. */
function page(title, extra = '') {
  return `<!doctype html>
<html lang="en" data-kb-headless="true">
<head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="assets/site.css"></head>
<body><main id="content"><h1>${title}</h1>${extra}</main></body>
</html>
`;
}

/** Lays out a workspace: a manifest plus a built site. */
function workspace(name, { manifest, files }) {
  const ws = join(root, name);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(join(ws, 'dist'), { recursive: true });
  if (manifest !== null) {
    writeFileSync(join(ws, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(ws, 'dist', dirname(rel)), { recursive: true });
    writeFileSync(join(ws, 'dist', rel), content);
  }
  return ws;
}

/** Runs the real entry point over a workspace. */
function publish(ws) {
  const artifact = join(ws, ASSET_NAME);
  const stdout = execFileSync(process.execPath, [ENTRY], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KB_WORKSPACE: ws,
      KB_MANIFEST: join(ws, MANIFEST),
      KB_DIST: join(ws, 'dist'),
      KB_STAGE: join(ws, '.stage'),
      KB_ARTIFACT: artifact,
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
    },
  });
  return { artifact, stdout };
}

/** Runs it expecting failure, returning the combined output. */
function publishExpectingFailure(ws) {
  try {
    publish(ws);
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  throw new Error('expected the publish to fail, but it succeeded');
}

const ONE_APP = {
  kbVersion: '1',
  apps: [{
    slug: 'my-service',
    name: 'My Service',
    description: 'What the service does and how to use it.',
    icon: 'cube',
    tags: ['platform'],
    entryPoint: 'index.html',
  }],
};

try {
  // ── Manifest validation ────────────────────────────────────────────────────
  //
  // The schema is the contract; these pin that the action reports against it,
  // and reports everything at once.
  console.log('\nManifest validation');

  check('rejects a manifest that is not there, naming the file', () => {
    assert.throws(() => readManifestFile(join(root, 'nope', MANIFEST)), (err) => {
      assert.ok(err instanceof PublishError);
      assert.match(err.message, /No manifest at/);
      assert.match(err.message, /contract\/ARTIFACT\.md/);
      return true;
    });
  });

  check('reports every contract violation at once, not one per run', () => {
    assert.throws(() => buildManifest([
      { slug: 'Not_A_Slug', name: 'x', description: 'too short' },
    ]), (err) => {
      assert.ok(err instanceof PublishError);
      assert.match(err.message, /slug/);
      assert.match(err.message, /name/);
      assert.match(err.message, /description/);
      return true;
    });
  });

  check('rejects an unknown icon and names the allowed set', () => {
    assert.throws(() => buildManifest([
      { slug: 'ok', name: 'Fine', description: 'A description long enough.', icon: 'rocket' },
    ]), (err) => {
      assert.match(err.message, /icon/);
      assert.match(err.message, /book-open/);
      return true;
    });
  });

  // ── HTML verification ──────────────────────────────────────────────────────
  //
  // Every one of these is a real artifact the knowledge base would accept and
  // then serve wrongly. Catching them here puts the message in front of the
  // person who can fix it, while they are still looking at their own CI.
  console.log('\nHTML verification');

  check('flags a page missing the headless marker', () => {
    const ws = workspace('no-marker', {
      manifest: ONE_APP,
      files: { 'index.html': '<!doctype html><html lang="en"><body>hi</body></html>' },
    });
    assert.match(publishExpectingFailure(ws), /missing data-kb-headless/);
  });

  check('names the pre-v1 marker specifically rather than calling it missing', () => {
    const ws = workspace('legacy-marker', {
      manifest: ONE_APP,
      files: { 'index.html': '<!doctype html><html lang="en" data-mp-headless="true"><body>hi</body></html>' },
    });
    assert.match(publishExpectingFailure(ws), /data-mp-headless.*pre-v1/);
  });

  check('flags a <base> element', () => {
    const ws = workspace('has-base', {
      manifest: ONE_APP,
      files: { 'index.html': page('X').replace('<head>', '<head><base href="/">') },
    });
    assert.match(publishExpectingFailure(ws), /<base> element/);
  });

  check('flags root-relative asset URLs', () => {
    const ws = workspace('absolute-urls', {
      manifest: ONE_APP,
      files: { 'index.html': page('X', '<img src="/images/logo.png">') },
    });
    const out = publishExpectingFailure(ws);
    assert.match(out, /root-relative URL/);
    assert.match(out, /\/images\/logo\.png/);
  });

  check('flags a pages entry pointing at a file that was not built', () => {
    const ws = workspace('stale-pages', {
      manifest: {
        kbVersion: '1',
        apps: [{
          ...ONE_APP.apps[0],
          pages: [
            { title: 'Home', path: 'index.html', order: 0 },
            { title: 'Gone', path: 'gone/index.html', order: 1 },
          ],
        }],
      },
      files: { 'index.html': page('Home') },
    });
    const out = publishExpectingFailure(ws);
    assert.match(out, /"Gone"/);
    assert.match(out, /not in the built output/);
  });

  check('flags a missing entryPoint', () => {
    const ws = workspace('no-entry', {
      manifest: ONE_APP,
      files: { 'other.html': page('Other') },
    });
    assert.match(publishExpectingFailure(ws), /entryPoint "index\.html" does not exist/);
  });

  check('warns about inline scripts without failing the publish', () => {
    const ws = workspace('inline-script', {
      manifest: ONE_APP,
      files: { 'index.html': page('X', '<script>console.log(1)</script>') },
    });
    const { stdout, artifact } = publish(ws);
    assert.match(stdout, /::warning::.*inline <script>/);
    assert.ok(existsSync(artifact), 'a warning must not block the publish');
  });

  check('accepts a page whose only absolute URL is a favicon', () => {
    const { errors } = verifyApp(
      workspace('favicon', {
        manifest: ONE_APP,
        files: { 'index.html': page('X', '<link rel="icon" href="/favicon.ico">') },
      }) + '/dist',
      ONE_APP.apps[0],
    );
    assert.deepEqual(errors, []);
  });

  // ── Packing ────────────────────────────────────────────────────────────────
  console.log('\nArtifact');

  const single = workspace('single', {
    manifest: ONE_APP,
    files: {
      'index.html': page('My Service'),
      'assets/site.css': '.kb-doc { color: red }',
      'guide/index.html': page('Guide'),
    },
  });
  const { artifact, stdout } = publish(single);

  check('packs kb-docs.json at the root with one directory per app', () => {
    const members = execFileSync('tar', ['--force-local', '-tzf', artifact], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    assert.ok(members.includes(MANIFEST), `expected ${MANIFEST} at the root`);
    assert.ok(members.some((m) => m === 'my-service/index.html'), members.join(' '));
    assert.ok(members.some((m) => m === 'my-service/guide/index.html'), members.join(' '));
    // No wrapper: the site's own dist/ becomes <slug>/, it is not nested inside it.
    assert.ok(!members.some((m) => m.startsWith('dist/') || m.startsWith('./')), members.join(' '));
  });

  check('the packed manifest is the repository\'s, unchanged', () => {
    const dir = join(single, '.unpack');
    mkdirSync(dir, { recursive: true });
    execFileSync('tar', ['--force-local', '-xzf', artifact, '-C', dir]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')), ONE_APP);
  });

  check('reports the apps it published', () => {
    assert.match(stdout, /my-service/);
    assert.match(stdout, /My Service/);
  });

  check('packing is deterministic — identical input, identical bytes', () => {
    const first = readFileSync(artifact);
    rmSync(artifact);
    publish(single);
    assert.deepEqual(readFileSync(artifact), first);
  });

  // ── Several apps in one artifact ───────────────────────────────────────────
  console.log('\nMultiple apps');

  const TWO_APPS = {
    kbVersion: '1',
    apps: [
      { slug: 'svc-guide', name: 'Guide', description: 'The user guide for the service.' },
      { slug: 'svc-ops',   name: 'Operations', description: 'Running the service in production.' },
    ],
  };

  check('a manifest with several apps reads one subdirectory per slug', () => {
    const ws = workspace('multi', {
      manifest: TWO_APPS,
      files: {
        'svc-guide/index.html': page('Guide'),
        'svc-ops/index.html': page('Operations'),
      },
    });
    const { artifact: multi } = publish(ws);
    const members = execFileSync('tar', ['--force-local', '-tzf', multi], { encoding: 'utf8' });
    assert.match(members, /svc-guide\/index\.html/);
    assert.match(members, /svc-ops\/index\.html/);
  });

  check('says which subdirectory is missing when one app has no output', () => {
    const ws = workspace('multi-missing', {
      manifest: TWO_APPS,
      files: { 'svc-guide/index.html': page('Guide') },
    });
    const out = publishExpectingFailure(ws);
    assert.match(out, /svc-ops/);
    assert.match(out, /one subdirectory per slug/);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n\x1b[31m✗ publish-docs self-test: ${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ publish-docs self-test passed\x1b[0m');
