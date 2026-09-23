#!/usr/bin/env node
/**
 * check-cli.js — runs the contract checks outside a release.
 *
 * The publish-docs action runs the same checks at release time; this is for
 * everywhere else: a docs repo's pull-request CI, a local build, an agent
 * fixing a repo. It reads nothing but the manifest and the built output, and
 * never packs or uploads.
 *
 *   node actions/lib/check-cli.js [--manifest kb-docs.json] [--dist dist] [--json] [--strict]
 *
 * Exit status: 1 when there is an error finding (or any finding under
 * --strict), 0 otherwise. --json prints the findings as a JSON array, for a
 * caller that wants to act on rule IDs rather than read prose.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { appDirResolver, checkApps } from './check.js';
import { PublishError, readManifestFile } from './manifest.js';
import { RULES_DOC, finding, formatFinding } from './rules.js';

function parseArgs(argv) {
  const args = { manifest: 'kb-docs.json', dist: 'dist', json: false, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--strict') args.strict = true;
    else if (arg === '--manifest' || arg === '--dist') args[arg.slice(2)] = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument "${arg}". Try --help.`);
  }
  return args;
}

function collect({ manifest: manifestPath, dist }) {
  let manifest;
  try {
    manifest = readManifestFile(resolve(manifestPath));
  } catch (err) {
    if (!(err instanceof PublishError)) throw err;
    return [finding('KB-MAN-001', manifestPath, err.message.replace(/^KB-MAN-001 /, ''))];
  }
  const distDir = resolve(dist);
  if (!existsSync(distDir)) {
    return [finding('KB-ART-001', dist, `the built output directory does not exist. Build the site first, or pass --dist.`)];
  }
  const appDirFor = appDirResolver(manifest, distDir);
  const missing = manifest.apps.filter((app) => !existsSync(appDirFor(app.slug)));
  if (missing.length > 0) {
    return missing.map((app) => finding('KB-ART-001', app.slug,
      `no built output at ${appDirFor(app.slug)} — with several apps, --dist holds one subdirectory per slug.`));
  }
  return checkApps(manifest, appDirFor);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: check-cli.js [--manifest kb-docs.json] [--dist dist] [--json] [--strict]');
    return 0;
  }

  const findings = collect(args);
  const errors = findings.filter((f) => f.severity === 'error').length;

  if (args.json) {
    console.log(JSON.stringify(findings, null, 2));
  } else if (findings.length === 0) {
    console.log('No findings — the built output satisfies the knowledge base contract.');
  } else {
    for (const f of findings) console.log(`${f.severity.padEnd(7)} ${formatFinding(f)}`);
    console.log(`\n${errors} error(s), ${findings.length - errors} warning(s). Each rule is explained in ${RULES_DOC}.`);
  }
  return errors > 0 || (args.strict && findings.length > 0) ? 1 : 0;
}

process.exitCode = main();
