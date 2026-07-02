/**
 * setup-test-apps.mjs
 *
 * Regenerates the hermetic apps.json used by the E2E test harness.
 *
 * The committed apps.json is this script's output; the Playwright webServer runs
 * it before every build so the registry stays in sync. It registers the vendored
 * docs-example fixture twice (two slugs) so the suite can exercise both the
 * landing catalog and cross-app navigation — no network, no GITHUB_TOKEN, no
 * sibling repo or per-app build toolchain.
 *
 * The `prebuilt` field is consumed by scripts/build-vite.js (preparePrebuilt).
 *
 * Override the artifact with KB_EXAMPLE_ARTIFACT (absolute path or path relative
 * to the repo root) — e.g. to point at a different doc app's dist.tar.gz / dist.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

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
];

const out = join(ROOT, 'apps.json');
writeFileSync(out, JSON.stringify(apps, null, 2) + '\n');
console.log(`\x1b[32m✓\x1b[0m wrote ${out} (${apps.length} apps from ${artifact})`);
