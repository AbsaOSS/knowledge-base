/**
 * rules.js — the contract's rules, by ID.
 *
 * contract/RULES.md is the normative text: what each rule requires, why, and
 * how to fix a violation. This is the machine side of the same catalogue, and
 * the self-test fails if the two list different IDs or severities.
 *
 * Severity is what the publishing action does with a finding: an `error` stops
 * the publish, a `warning` is annotated on the run and the publish goes ahead.
 * New rules start as warnings; turning one into an error breaks repos that
 * published fine yesterday, so that only happens with a major version.
 */

export const RULES = Object.freeze({
  'KB-MAN-001': { severity: 'error',   title: 'kb-docs.json exists and satisfies the schema' },
  'KB-ART-001': { severity: 'error',   title: 'The entry point exists in the built output' },
  'KB-ART-002': { severity: 'error',   title: 'Every pages entry exists in the built output' },
  'KB-ART-003': { severity: 'error',   title: 'Each app contains HTML' },
  'KB-ART-004': { severity: 'warning', title: 'The artifact is at most 20 MB' },
  'KB-ART-005': { severity: 'error',   title: 'The artifact is at most 100 MB' },
  'KB-HTML-001': { severity: 'error',   title: 'Every page is marked headless' },
  'KB-HTML-002': { severity: 'error',   title: 'No <base> element' },
  'KB-HTML-003': { severity: 'error',   title: 'No root-relative URLs' },
  'KB-HTML-004': { severity: 'warning', title: 'No inline <script> blocks' },
  'KB-HTML-005': { severity: 'warning', title: 'No inline event handler attributes' },
  'KB-HTML-006': { severity: 'warning', title: 'No javascript: URLs' },
  'KB-HTML-007': { severity: 'warning', title: 'No site-level <header>' },
  'KB-HTML-008': { severity: 'warning', title: 'No links to non-HTML files in the app' },
  'KB-CSS-001':  { severity: 'warning', title: 'No !important declarations' },
  'KB-THEME-001': { severity: 'warning', title: 'No dark mode' },
  'KB-CSP-001':  { severity: 'warning', title: 'No scripts, stylesheets or fonts from another origin' },
  'KB-JS-001':   { severity: 'warning', title: 'No fetches of page-relative URLs' },
});

/** Where a finding's rule is explained. */
export const RULES_DOC = 'contract/RULES.md';

/**
 * A finding: one rule, one place, one message.
 *
 * @param {string} id      - a key of RULES
 * @param {string} where   - `<slug>/<file>`, or whatever names the place
 * @param {string} message - what is wrong and what to do, for the repo author
 */
export function finding(id, where, message) {
  const rule = RULES[id];
  if (!rule) throw new Error(`Unknown rule ${id} — add it to actions/lib/rules.js and ${RULES_DOC}.`);
  return { id, severity: rule.severity, where, message };
}

/** One line per finding, as the action and the CLI print it. */
export function formatFinding(f) {
  return `${f.id} ${f.where}: ${f.message}`;
}
