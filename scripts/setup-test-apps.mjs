/**
 * setup-test-apps.mjs
 *
 * Generates a hermetic apps.json for the E2E test harness.
 *
 * apps.json is gitignored (it normally points at private GitHub repos), so the
 * tests can't rely on a checked-in one. This script writes a registry that uses
 * the local `knowledge-base-docs-example` prebuilt artifact — twice, under two
 * slugs — so the suite can exercise both the landing catalog and cross-app
 * navigation without any network access or per-app build toolchain.
 *
 * The `prebuilt` field is consumed by scripts/build-vite.js (preparePrebuilt).
 *
 * Override the example location with KB_EXAMPLE_ARTIFACT (absolute path or path
 * relative to the repo root) — e.g. to point at a different doc app's dist.tar.gz.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const DEFAULT_ARTIFACT = '../knowledge-base-docs-example/dist.tar.gz';
const artifact = process.env.KB_EXAMPLE_ARTIFACT || DEFAULT_ARTIFACT;
const artifactAbs = isAbsolute(artifact) ? artifact : resolve(ROOT, artifact);

if (!existsSync(artifactAbs)) {
  console.error(
    `\x1b[31m✗ Example artifact not found:\x1b[0m ${artifactAbs}\n` +
    `  Expected the prebuilt docs example at ../knowledge-base-docs-example/dist.tar.gz\n` +
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
    description: 'Primary docs app — the knowledge-base-docs-example used as the integration guinea pig.',
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
];

const out = join(ROOT, 'apps.json');
writeFileSync(out, JSON.stringify(apps, null, 2) + '\n');
console.log(`\x1b[32m✓\x1b[0m wrote ${out} (${apps.length} apps from ${artifact})`);
