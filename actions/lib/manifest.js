/**
 * manifest.js — building and validating kb-docs.json.
 *
 * Both publishing actions end up here: one derives the manifest from workflow
 * inputs, the other reads one the repo wrote by hand. Either way it is checked
 * against contract/kb-docs.schema.json before anything is packed, so a repo
 * cannot publish an artifact the knowledge base will refuse.
 *
 * The schema is read from the checkout rather than fetched over the network. A
 * remote `uses:` checks out this whole repository at the ref the caller pinned,
 * so the schema is always the one that matches the action's own version — and a
 * publish never depends on raw.githubusercontent being reachable.
 */

import Ajv from 'ajv';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Manifest file name at the root of the artifact. */
export const MANIFEST = 'kb-docs.json';
/** Release asset name. Must match src/utils/registry.js in the knowledge base. */
export const ASSET_NAME = 'kb-docs.tar.gz';
/** Contract version this action publishes. */
export const KB_VERSION = '1';

/** contract/kb-docs.schema.json, relative to actions/lib/. */
const SCHEMA_PATH = join(__dirname, '..', '..', 'contract', 'kb-docs.schema.json');

/** Raised for anything the consuming repo can fix; reported without a stack. */
export class PublishError extends Error {}

let compiled = null;

/** Compiles the contract schema once per process. */
function validator() {
  if (compiled) return compiled;
  if (!existsSync(SCHEMA_PATH)) {
    throw new PublishError(
      `The contract schema is missing from the action checkout (${SCHEMA_PATH}). ` +
      `This is a bug in the action, not in your repository — please open an issue.`,
    );
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  compiled = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return compiled;
}

/**
 * Validates a manifest object against the contract.
 *
 * Reports **every** problem at once, each naming the field and what is wrong:
 * a publish workflow that fails one error at a time turns a five-field mistake
 * into five round trips through CI.
 *
 * @param {object} manifest
 * @param {string} source - where the manifest came from, for the message
 */
export function validateManifest(manifest, source) {
  const validate = validator();
  if (validate(manifest)) return manifest;

  const lines = validate.errors.map((err) => {
    const where = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(root)';
    const extra = err.params?.allowedValues ? ` (allowed: ${err.params.allowedValues.join(', ')})` : '';
    const named = err.params?.additionalProperty ? ` "${err.params.additionalProperty}"` : '';
    return `  • ${where}${named}: ${err.message}${extra}`;
  });

  throw new PublishError(
    `${source} does not satisfy the knowledge base contract:\n${[...new Set(lines)].join('\n')}\n\n` +
    `See contract/ARTIFACT.md for what each field means.`,
  );
}

/**
 * Reads a manifest a repository wrote itself.
 *
 * @param {string} file - path to kb-docs.json
 */
export function readManifestFile(file) {
  if (!existsSync(file)) {
    throw new PublishError(
      `No manifest at ${file}.\n` +
      `Create a ${MANIFEST} in your repository root describing the app(s) this release publishes — ` +
      `see contract/ARTIFACT.md for the shape, or set the action's "manifest" input if it lives elsewhere.`,
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new PublishError(`${file} is not valid JSON — ${err.message}`);
  }
  return validateManifest(manifest, file);
}

/**
 * Builds a manifest from already-validated app descriptors.
 *
 * @param {Array} apps - objects carrying slug, name, description and optionals
 */
export function buildManifest(apps) {
  const manifest = {
    kbVersion: KB_VERSION,
    apps: apps.map((app) => ({
      slug:        app.slug,
      name:        app.name,
      description: app.description,
      ...(app.icon        ? { icon: app.icon }             : {}),
      ...(app.tags?.length ? { tags: app.tags }            : {}),
      entryPoint:  app.entryPoint ?? 'index.html',
      ...(app.pages?.length ? { pages: app.pages }         : {}),
    })),
  };
  return validateManifest(manifest, 'the manifest derived from your workflow inputs');
}

/** Writes a manifest to the root of a staging directory. */
export function writeManifest(stageDir, manifest) {
  writeFileSync(join(stageDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}
