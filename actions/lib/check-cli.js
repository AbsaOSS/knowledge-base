#!/usr/bin/env node
/**
 * check-cli.js — runs the contract checks outside a release.
 *
 * The publish-docs action runs the same checks at release time and the
 * check-docs action on pull requests; this is for everywhere else: a local
 * build, an agent fixing a repo. It reads nothing but the manifest and the
 * built output, and never packs or uploads.
 *
 *   node actions/lib/check-cli.js [--manifest kb-docs.json] [--dist dist] [--json] [--strict]
 *
 * Exit status: 1 when there is an error finding (or any finding under
 * --strict), 0 otherwise. --json prints the findings as a JSON array, for a
 * caller that wants to act on rule IDs rather than read prose.
 */

import { checkWorkspace } from './check.js';
import { RULES_DOC, formatFinding } from './rules.js';

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: check-cli.js [--manifest kb-docs.json] [--dist dist] [--json] [--strict]');
    return 0;
  }

  const findings = checkWorkspace(args);
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
