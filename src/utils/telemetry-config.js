import { existsSync, readFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REGISTRY_FILE } from './config.js';

const DEFAULT_SHELL_ADAPTER = fileURLToPath(new URL('../scripts/no-shell.js', import.meta.url));
const TELEMETRY_BOOT = fileURLToPath(new URL('../scripts/telemetry-boot.js', import.meta.url));
const TELEMETRY_OFF = fileURLToPath(new URL('../scripts/telemetry-off.js', import.meta.url));

const FIELDS = ['enabled', 'application', 'environment', 'eventNamespace'];
const versions = new Map();

/**
 * Validates the deployment's sidecar before any of it is emitted into pages:
 * only allowlisted identity fields, so nothing private can ride along.
 * @param {unknown} value
 */
export function validateTelemetryConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Telemetry configuration must be an object');
  }
  if (Object.keys(value).some((key) => !FIELDS.includes(key))) {
    throw new Error('Telemetry configuration contains unsupported fields');
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('Telemetry enabled must be a boolean');
  }
  for (const field of ['application', 'environment', 'eventNamespace']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`Telemetry ${field} must be a non-empty string`);
    }
  }
  const { enabled, application, environment, eventNamespace } = value;
  return { enabled, application, environment, eventNamespace };
}

export function telemetryConfigPath(root, env = process.env, registryFile = REGISTRY_FILE) {
  if (env.KB_TELEMETRY_CONFIG?.trim()) return resolve(root, env.KB_TELEMETRY_CONFIG.trim());
  const registry = parse(resolve(root, registryFile));
  return join(registry.dir, `${registry.name}.telemetry.json`);
}

/**
 * Telemetry is compiled out by default. `KB_TELEMETRY=true` includes Watchtower,
 * the shell adapter and telemetry metadata. Other non-empty values are rejected
 * unless they are `false`.
 */
export function isTelemetryBuild(env = process.env) {
  const value = env.KB_TELEMETRY?.trim();
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('KB_TELEMETRY must be "true" or "false"');
}

/** The module the browser bundle imports as `kb-telemetry`. */
export function telemetryModulePath(env = process.env) {
  return isTelemetryBuild(env) ? TELEMETRY_BOOT : TELEMETRY_OFF;
}

/**
 * The module the browser bundle imports as `kb-shell-adapter`: how this
 * deployment's host shell is detected and told the page is ready. Owned by the
 * deployment, beside its registry; without one the knowledge base runs shell-less.
 */
export function shellAdapterPath(root = process.cwd(), env = process.env, registryFile = REGISTRY_FILE) {
  const explicit = env.KB_SHELL_ADAPTER?.trim();
  if (explicit) {
    const file = resolve(root, explicit);
    if (!existsSync(file)) throw new Error('Explicit KB_SHELL_ADAPTER file does not exist');
    return file;
  }
  const registry = parse(resolve(root, registryFile));
  const beside = join(registry.dir, 'kb-shell.mjs');
  return existsSync(beside) ? beside : DEFAULT_SHELL_ADAPTER;
}

function sourceVersion(root) {
  if (versions.has(root)) return versions.get(root);
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  let revision;
  try {
    revision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.warn('[KB telemetry] Git revision unavailable; using the package version');
  }
  const result = revision ? `${version}+${revision.slice(0, 12)}` : version;
  versions.set(root, result);
  return result;
}

export function loadTelemetryConfig(root = process.cwd(), env = process.env) {
  const file = telemetryConfigPath(root, env);
  if (!existsSync(file)) {
    if (env.KB_TELEMETRY_CONFIG?.trim()) {
      throw new Error('Explicit KB_TELEMETRY_CONFIG file does not exist');
    }
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error('Telemetry configuration could not be read as JSON');
  }
  const identity = validateTelemetryConfig(raw);
  return { ...identity, version: sourceVersion(root) };
}
