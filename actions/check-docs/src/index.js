/**
 * index.js — entry point of the check-docs action.
 *
 * Runs the contract checks (lib/check.js, rules in contract/RULES.md) on a
 * docs repo's manifest and built output, the way publish-docs will at release
 * time, but on a pull request and without packing or uploading anything. A
 * finding that would fail the publish then fails the pull request instead, a
 * release earlier.
 *
 * Annotations are one per rule, not one per finding: a docs site repeats one
 * template on every page, and GitHub shows only the first few annotations of a
 * step. The job summary carries every finding.
 *
 * Env:
 *   KB_MANIFEST      path to kb-docs.json, relative to the workspace (default: kb-docs.json)
 *   KB_DIST          built output, relative to the workspace         (default: dist)
 *   KB_CHECK_STRICT  "true" fails on warnings too
 */

import { checkWorkspace, summarise } from '../../lib/check.js';
import { PublishError } from '../../lib/manifest.js';
import { RULES_DOC, formatFinding } from '../../lib/rules.js';
import { annotate, run, setOutput, summary } from '../../lib/runner.js';

const RULES_URL = 'https://github.com/AbsaOSS/knowledge-base/blob/master/contract/RULES.md';

/** A table cell: pipes escaped, newlines flattened. */
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function report(findings, strict) {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const groups = summarise(findings);

  for (const g of groups) annotate(g.line, { level: g.severity, title: g.id });

  const verdict = errors > 0 || (strict && warnings > 0) ? 'fails' : 'passes';
  let md = `### Knowledge base contract: ${errors} error(s), ${warnings} warning(s)\n\n`;
  if (findings.length === 0) {
    md += 'No findings — the built output satisfies the knowledge base contract.\n';
  } else {
    md += `The check ${verdict}${strict ? ' (strict: warnings fail too)' : ''}. Every rule is explained in [${RULES_DOC}](${RULES_URL}).\n\n`;
    md += '| Rule | Severity | Count | First finding |\n|---|---|---|---|\n';
    for (const g of groups) {
      md += `| ${g.id} | ${g.severity} | ${g.count} | ${cell(`${g.first.where}: ${g.first.message}`)} |\n`;
    }
    md += `\n<details><summary>All ${findings.length} finding(s)</summary>\n\n`;
    md += findings.map((f) => `- \`${f.severity}\` ${cell(formatFinding(f))}`).join('\n');
    md += '\n\n</details>\n';
  }
  summary(md);

  setOutput('errors', String(errors));
  setOutput('warnings', String(warnings));
  return { errors, warnings };
}

function main() {
  const strict = process.env.KB_CHECK_STRICT === 'true';
  const findings = checkWorkspace({
    manifest: process.env.KB_MANIFEST || 'kb-docs.json',
    dist: process.env.KB_DIST || 'dist',
  });

  for (const f of findings) console.log(`${f.severity.padEnd(7)} ${formatFinding(f)}`);
  const { errors, warnings } = report(findings, strict);
  console.log(`\n${errors} error(s), ${warnings} warning(s). Each rule is explained in ${RULES_DOC}.`);

  if (errors > 0) {
    throw new PublishError(`${errors} error finding(s): the publish-docs action would refuse this output. See the annotations and the job summary.`);
  }
  if (strict && warnings > 0) {
    throw new PublishError(`${warnings} warning finding(s), and "strict" is on. See the annotations and the job summary.`);
  }
}

run(main);
