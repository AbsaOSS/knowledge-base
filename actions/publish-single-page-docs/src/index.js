/**
 * index.js — entry point of the publish-docs action's build step.
 *
 * Reads the action inputs from the environment (composite actions pass them as
 * env vars, not INPUT_*), validates them, renders the bundle and packs it. The
 * upload to the GitHub Release happens in the action's next step, which reads
 * the artifact path from this script's step outputs.
 *
 * Env:
 *   KB_DOCS       (required) YAML/JSON list of doc definitions
 *   KB_WORKSPACE  repo checkout root                    (default: cwd)
 *   KB_STAGE      staging directory for the bundle      (default: <cwd>/.kb-single-page)
 *   KB_ARTIFACT   destination tarball                   (default: <stage>/../kb-docs.tar.gz)
 *   GITHUB_OUTPUT step-output file written by the runner (optional)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildBundle, packBundle, ASSET_NAME } from './bundle.js';
import { InputError, parseDocsInput, validateDocs } from './inputs.js';

/** Emits a GitHub Actions error annotation (newlines must be escaped). */
function annotate(message) {
  const encoded = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::error::${encoded}\n`);
}

/** Appends `key=value` to the runner's step-output file when running in CI. */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Heredoc form so values containing newlines or `=` survive intact.
  const delimiter = `kb_${key}_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function main() {
  const workspace = resolve(process.env.KB_WORKSPACE || process.cwd());
  const stageDir  = resolve(process.env.KB_STAGE || join(workspace, '.kb-single-page'));
  const artifact  = resolve(process.env.KB_ARTIFACT || join(stageDir, '..', ASSET_NAME));

  const docs = validateDocs(parseDocsInput(process.env.KB_DOCS ?? ''), workspace);

  console.log(`Rendering ${docs.length} doc(s) for the knowledge base:`);
  mkdirSync(stageDir, { recursive: true });
  const { manifest, rendered } = buildBundle(docs, stageDir);

  for (const doc of rendered) {
    const extras = doc.usesMermaid ? ' [mermaid]' : '';
    console.log(`  • ${doc.slug.padEnd(24)} ← ${doc.md}${extras}`);
  }

  packBundle(stageDir, artifact, manifest);
  console.log(`\nBundle packed: ${artifact}`);

  setOutput('artifact', artifact);
  setOutput('slugs', docs.map((d) => d.slug).join(','));
  setOutput('count', String(docs.length));
}

try {
  main();
} catch (err) {
  if (err instanceof InputError) {
    // The onboarding repo's workflow is wrong — say precisely what to change.
    annotate(err.message);
    process.stderr.write(`\n${err.message}\n`);
  } else {
    annotate(err.message);
    process.stderr.write(`\n${err.stack || err.message}\n`);
  }
  process.exit(1);
}
