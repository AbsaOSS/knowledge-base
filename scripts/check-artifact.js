/**
 * check-artifact.js — the contract checker, run on every artifact the build installs.
 *
 * The publish-docs action checks a docs repo's output before it is released
 * (actions/lib/check.js, rules in contract/RULES.md). This runs the same checks
 * again on what the knowledge base actually received, because not every
 * artifact went through a current action: one published before a rule existed,
 * one packed by hand, one from a pinned older action. The build repairs some
 * findings as it re-hosts a page (it hoists inline scripts, strips dark mode,
 * rebases URLs), so the report is for whoever owns the registry: which docs
 * repo to chase, and for what.
 *
 * check.js resolves its parsers from actions/node_modules when that tree is
 * installed and from the root node_modules otherwise. The root package.json
 * pins htmlparser2 and postcss to the versions actions/package.json pins, so
 * either way the build and the action parse the same way
 * (tests/artifact-checks.spec.js holds the two in step).
 */

import { summarise } from '../actions/lib/check.js';
import { RULES_DOC, formatFinding } from '../actions/lib/rules.js';

export { checkApp, summarise } from '../actions/lib/check.js';

/**
 * Reports one artifact's findings through the build's logger.
 *
 * Errors are rules the publish action refuses to release. In a strict
 * (production) build they fail the build: an artifact that breaks the contract
 * reached the registry some other way, and a deployment should not ship it
 * unnoticed. Otherwise every finding is a warning, since the build still serves
 * the page. Returns the counts, for the build's summary.
 *
 * @param {string} key      - the registry source, for the messages
 * @param {Array} findings  - from checkApp, across the artifact's apps
 * @param {{strict: boolean, warn: (msg: string) => void}} options
 */
export function reportFindings(key, findings, { strict, warn }) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.length - errors.length;

  if (strict && errors.length > 0) {
    throw new Error(
      `${key}: the artifact breaks the knowledge base contract (see ${RULES_DOC}):\n` +
      errors.map((e) => `     • ${formatFinding(e)}`).join('\n') + '\n' +
      `     The publish-docs action refuses these; republish with a current action.`,
    );
  }

  for (const { severity, line } of summarise(findings)) warn(`${key}: ${severity} ${line}`);
  if (findings.length > 0) {
    warn(`${key}: ${errors.length} error(s), ${warnings} warning(s) against ${RULES_DOC} — the docs repo can run the same checks with actions/lib/check-cli.js.`);
  }
  return { errors: errors.length, warnings };
}
