/**
 * selftest.js — `npm run selftest` inside actions/publish-single-page-docs.
 *
 * Exercises the action without a runner: renders a sample markdown file through
 * the real pipeline and asserts the markdown features the contract promises, the
 * headless rules, and the shape of bundle.json. Also pins the validation error
 * messages, since those are the action's user interface for onboarding repos.
 *
 * Kept out of the marketplace's Playwright suite on purpose: that suite must stay
 * hermetic and must not depend on this action's node_modules.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBundle, packBundle, BUNDLE_MANIFEST } from './bundle.js';
import { InputError, parseDocsInput, validateDocs } from './inputs.js';

const SAMPLE = `# Service Overview

Ships a thing. See https://example.com/handbook for context.[^1]

## Interfaces

| Endpoint | Method | Notes |
|---|---|---|
| \`/health\` | GET | Liveness probe |
| \`/v1/items\` | POST | Creates an item |

- [x] Contract published
- [ ] Load-tested

\`\`\`js
export const port = Number(process.env.PORT ?? 8080);
\`\`\`

\`\`\`mermaid
flowchart LR
  client --> gateway --> service
\`\`\`

[^1]: The handbook is internal.
`;

const root = mkdtempSync(join(tmpdir(), 'kb-publish-single-page-docs-'));
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

try {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'overview.md'), SAMPLE);

  console.log('\nInput validation');

  check('rejects a non-list input with an actionable message', () => {
    assert.throws(() => parseDocsInput('md: docs/overview.md'), (err) => {
      assert.ok(err instanceof InputError);
      assert.match(err.message, /must be a LIST/);
      return true;
    });
  });

  check('rejects a bad slug, a missing file and a duplicate slug together', () => {
    const raw = `
- md: docs/overview.md
  title: A
  description: A description that is long enough.
  slug: Not_A_Slug
- md: docs/missing.md
  title: B
  description: Another description that is long enough.
  slug: overview
- md: docs/overview.md
  title: C
  description: Yet another description long enough.
  slug: overview
`;
    assert.throws(() => validateDocs(parseDocsInput(raw), root), (err) => {
      assert.ok(err instanceof InputError, 'expected an InputError');
      assert.match(err.message, /slug "Not_A_Slug" is invalid/);
      assert.match(err.message, /does not exist in the repository/);
      assert.match(err.message, /already used by docs\[1\]/);
      return true;
    });
  });

  check('rejects an unsupported icon and lists the allowed set', () => {
    const raw = `
- md: docs/overview.md
  title: Overview
  description: A description that is long enough.
  slug: overview
  icon: rocket
`;
    assert.throws(() => validateDocs(parseDocsInput(raw), root), (err) => {
      assert.match(err.message, /icon "rocket" is not supported/);
      assert.match(err.message, /book-open/);
      return true;
    });
  });

  check('rejects a path that escapes the checkout', () => {
    const raw = `
- md: ../../etc/passwd
  title: Overview
  description: A description that is long enough.
  slug: overview
`;
    assert.throws(() => validateDocs(parseDocsInput(raw), root), (err) => {
      assert.match(err.message, /must be a repository-relative path/);
      return true;
    });
  });

  console.log('\nBundle output');

  const docs = validateDocs(parseDocsInput(`
- md: docs/overview.md
  title: Service Overview
  description: What the service does and how to use it.
  slug: my-service
  icon: cube
  tags: [platform, api]
`), root);

  const stage = join(root, 'stage');
  const { manifest } = buildBundle(docs, stage);
  const html = readFileSync(join(stage, 'my-service', 'index.html'), 'utf8');

  check('manifest declares the single-page type and every doc', () => {
    assert.equal(manifest.marketplaceVersion, '1');
    assert.equal(manifest.type, 'single-page');
    assert.deepEqual(manifest.docs, [{
      slug: 'my-service',
      title: 'Service Overview',
      description: 'What the service does and how to use it.',
      icon: 'cube',
      tags: ['platform', 'api'],
      entryPoint: 'index.html',
    }]);
    assert.ok(existsSync(join(stage, BUNDLE_MANIFEST)));
  });

  check('document complies with contract/HEADLESS_RULES.md', () => {
    assert.match(html, /<html lang="en" data-mp-headless="true">/);
    assert.doesNotMatch(html, /<base\b/i);
    assert.doesNotMatch(html, /localStorage/);
    assert.doesNotMatch(html, /\bclass="dark"/);
    // No site-level header and no sidebar — the marketplace masthead is the chrome.
    assert.doesNotMatch(html, /<header class="fixed/);
    assert.doesNotMatch(html, /id="sidebar"/);
    // All asset references are relative (no leading slash).
    for (const [, url] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      assert.ok(!url.startsWith('/'), `asset path must be relative, got ${url}`);
    }
  });

  check('renders GitHub-flavoured markdown', () => {
    assert.match(html, /<table>/, 'tables');
    assert.match(html, /task-list-item/, 'task lists');
    assert.match(html, /href="https:\/\/example\.com\/handbook"/, 'autolinks');
    assert.match(html, /class="footnotes"/, 'footnotes');
  });

  check('highlights code fences', () => {
    assert.match(html, /<pre class="mp-code"><code class="hljs language-js">/);
    assert.match(html, /hljs-keyword/);
  });

  check('keeps mermaid sources and vendors the bundle instead of using a CDN', () => {
    assert.match(html, /<pre class="mermaid">flowchart LR/);
    assert.match(html, /<script src="assets\/mermaid\.min\.js">/);
    assert.doesNotMatch(html, /https?:\/\/[^"]*mermaid/);
    assert.ok(existsSync(join(stage, 'my-service', 'assets', 'mermaid.min.js')), 'mermaid not vendored');
  });

  check('ships the doc stylesheet alongside the page', () => {
    assert.match(html, /<link rel="stylesheet" href="assets\/doc\.css">/);
    const css = readFileSync(join(stage, 'my-service', 'assets', 'doc.css'), 'utf8');
    assert.match(css, /--color-kb-500: #af144b;/);
    assert.match(css, /\.mp-doc\b/);
  });

  check('packs a tarball with bundle.json at the root', () => {
    const tar = packBundle(stage, join(root, 'out', 'dist.tar.gz'));
    assert.ok(existsSync(tar));
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n\x1b[31m✗ ${failures} self-test check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ publish-single-page-docs self-test passed\x1b[0m\n');
