/**
 * setup-test-apps.mjs
 *
 * Regenerates the hermetic apps.json used by the E2E test harness, plus the
 * single-page bundle fixture it registers.
 *
 * The committed apps.json is this script's output; the Playwright webServer runs
 * it before every build so the registry stays in sync. It registers:
 *   • the vendored docs-example fixture twice (two slugs) so the suite can
 *     exercise both the landing catalog and cross-app navigation,
 *   • an iframe entry (issue #10),
 *   • a single-page bundle holding two docs (issue #35).
 * No network, no GITHUB_TOKEN, no sibling repo or per-app build toolchain.
 *
 * The `prebuilt` field is consumed by scripts/build-vite.js (preparePrebuilt).
 *
 * Override the packaged artifact with KB_EXAMPLE_ARTIFACT (absolute path or path
 * relative to the repo root) — e.g. to point at a different doc app's
 * dist.tar.gz / dist.
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DOC_CSS, CSS_PATH, MERMAID_PATH, renderDocument } from '../actions/publish-single-page-docs/src/template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Vendored fixture (committed under tests/fixtures/) keeps the build + tests fully
// hermetic — no sibling repo, no network, no GITHUB_TOKEN.
const DEFAULT_ARTIFACT = 'tests/fixtures/docs-example.dist.tar.gz';
const artifact = process.env.KB_EXAMPLE_ARTIFACT || DEFAULT_ARTIFACT;
const artifactAbs = isAbsolute(artifact) ? artifact : resolve(ROOT, artifact);

if (!existsSync(artifactAbs)) {
  console.error(
    `\x1b[31m✗ Example artifact not found:\x1b[0m ${artifactAbs}\n` +
    `  Expected the vendored fixture at tests/fixtures/docs-example.dist.tar.gz\n` +
    `  or set KB_EXAMPLE_ARTIFACT to a dist.tar.gz / dist directory.`,
  );
  process.exit(1);
}

// ── Single-page bundle fixture (issue #35) ───────────────────────────────────
//
// Written as an *unpacked* bundle directory (apps.json `prebuilt` accepts either
// a tarball or a directory), so it stays reviewable in git instead of being an
// opaque blob. It is regenerated here on every run and committed, so CI's plain
// `npm run build:headless` works without running this script first.
//
// The document shell comes from the real action (actions/publish-single-page-docs/src/
// template.js — deliberately dependency-free) so the fixture cannot drift from
// what a published bundle looks like. Only the *body* HTML is hand-written here,
// standing in for the markdown-it output, which keeps the marketplace test suite
// free of the action's node_modules.

const BUNDLE_DIR = 'tests/fixtures/single-page-bundle';

/** Body of doc 1 — headings, prose, table, code fence, task list, mermaid. */
const PLATFORM_OVERVIEW_BODY = `<h1 id="platform-overview" tabindex="-1">Platform Overview <a class="mp-anchor" href="#platform-overview">#</a></h1>
<p>The platform runs every service behind a single gateway. See
<a href="https://example.com/handbook" target="_blank" rel="noopener noreferrer">the handbook</a> for the long version.</p>
<h2 id="endpoints" tabindex="-1">Endpoints <a class="mp-anchor" href="#endpoints">#</a></h2>
<div class="mp-table-wrap">
<table>
<thead>
<tr><th>Endpoint</th><th>Method</th><th>Notes</th></tr>
</thead>
<tbody>
<tr><td><code>/health</code></td><td>GET</td><td>Liveness probe</td></tr>
<tr><td><code>/v1/items</code></td><td>POST</td><td>Creates an item</td></tr>
</tbody>
</table>
</div>
<h2 id="configuration" tabindex="-1">Configuration <a class="mp-anchor" href="#configuration">#</a></h2>
<pre class="mp-code"><code class="hljs language-js"><span class="hljs-keyword">export</span> <span class="hljs-keyword">const</span> port = <span class="hljs-title class_">Number</span>(process.<span class="hljs-property">env</span>.<span class="hljs-property">PORT</span> ?? <span class="hljs-number">8080</span>);</code></pre>
<h2 id="rollout-status" tabindex="-1">Rollout status <a class="mp-anchor" href="#rollout-status">#</a></h2>
<ul class="contains-task-list">
<li class="task-list-item"><input class="task-list-item-checkbox" checked disabled type="checkbox"> Contract published</li>
<li class="task-list-item"><input class="task-list-item-checkbox" disabled type="checkbox"> Load-tested</li>
</ul>
<h2 id="request-flow" tabindex="-1">Request flow <a class="mp-anchor" href="#request-flow">#</a></h2>
<pre class="mermaid">flowchart LR
  client --&gt; gateway --&gt; service</pre>`;

/** Body of doc 2 — a second doc in the same bundle, proving expansion. */
const RELEASE_PROCESS_BODY = `<h1 id="release-process" tabindex="-1">Release Process <a class="mp-anchor" href="#release-process">#</a></h1>
<p>Releases are cut from <code>master</code> on demand.</p>
<blockquote>
<p>A release is only complete once the docs bundle is attached to it.</p>
</blockquote>
<h2 id="steps" tabindex="-1">Steps <a class="mp-anchor" href="#steps">#</a></h2>
<ol>
<li>Tag the commit.</li>
<li>Publish the GitHub Release.</li>
<li>The publish-single-page-docs action attaches <code>dist.tar.gz</code>.</li>
</ol>`;

/**
 * Stand-in for the vendored mermaid bundle.
 *
 * The real action copies mermaid's 2.5 MB UMD build into each doc that needs it;
 * committing that to the fixture would bloat the repo for no test value. What the
 * suite actually needs is that the reference resolves (no 404 while browsing) and
 * that the diagram source survives the build.
 */
const MERMAID_STUB = `/* Test fixture stand-in for the vendored mermaid bundle. */
window.mermaid = { initialize: function () {}, run: function () {} };
`;

const bundleDocs = [
  {
    slug: 'platform-overview',
    title: 'Platform Overview',
    description: 'How the platform is wired together, endpoint by endpoint.',
    icon: 'layers',
    tags: ['platform', 'reference'],
    body: PLATFORM_OVERVIEW_BODY,
    usesMermaid: true,
  },
  {
    slug: 'release-process',
    title: 'Release Process',
    description: 'How a release is cut and how the docs bundle gets attached.',
    icon: 'cog',
    tags: ['process'],
    body: RELEASE_PROCESS_BODY,
    usesMermaid: false,
  },
];

function writeSinglePageBundle() {
  const root = resolve(ROOT, BUNDLE_DIR);
  rmSync(root, { recursive: true, force: true });

  for (const doc of bundleDocs) {
    const docDir = join(root, doc.slug);
    mkdirSync(join(docDir, dirname(CSS_PATH)), { recursive: true });

    writeFileSync(join(docDir, 'index.html'), renderDocument({
      title:       doc.title,
      description: doc.description,
      bodyHtml:    doc.body,
      usesMermaid: doc.usesMermaid,
      hasHeading:  true,
    }));
    writeFileSync(join(docDir, CSS_PATH), DOC_CSS);
    if (doc.usesMermaid) writeFileSync(join(docDir, MERMAID_PATH), MERMAID_STUB);
  }

  writeFileSync(join(root, 'bundle.json'), JSON.stringify({
    marketplaceVersion: '1',
    type: 'single-page',
    docs: bundleDocs.map(({ slug, title, description, icon, tags }) => ({
      slug, title, description, icon, tags, entryPoint: 'index.html',
    })),
  }, null, 2) + '\n');

  return root;
}

const bundleRoot = writeSinglePageBundle();

// ── Registry ─────────────────────────────────────────────────────────────────

// Two slugs from the same artifact: a primary app and a "mirror" so cross-app
// navigation (clicking from one app's card to another) is testable.
const apps = [
  {
    slug: 'user-guide',
    name: 'User Guide',
    description: 'Primary docs app — the vendored docs-example fixture used as the integration guinea pig.',
    icon: 'book-open',
    tags: ['guide', 'getting-started'],
    prebuilt: artifact,
  },
  {
    slug: 'guide-mirror',
    name: 'Guide Mirror',
    description: 'Second registered app (same artifact, different slug) for cross-app navigation tests.',
    icon: 'book-open',
    tags: ['mirror', 'cross-app'],
    prebuilt: artifact,
  },
  {
    // iframe onboarding mode (issue #10): no artifact, renders an <iframe>.
    slug: 'external-docs',
    name: 'External Docs',
    description: 'Iframe-onboarded external documentation site (temporary integration path).',
    icon: 'book-open',
    tags: ['external'],
    type: 'iframe',
    url: 'https://example.com/docs',
    temporary: true,
  },
  {
    // single-page onboarding mode (issue #35): one bundle, no per-doc metadata
    // here — the build expands it into one app per doc from bundle.json.
    type: 'single-page',
    prebuilt: BUNDLE_DIR,
  },
];

const out = join(ROOT, 'apps.json');
writeFileSync(out, JSON.stringify(apps, null, 2) + '\n');
console.log(
  `\x1b[32m✓\x1b[0m wrote ${out} (${apps.length} entries from ${artifact})\n` +
  `\x1b[32m✓\x1b[0m wrote ${bundleRoot} (${bundleDocs.length} single-page docs)`,
);
