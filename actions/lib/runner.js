/**
 * runner.js — the small amount of GitHub Actions plumbing both actions need.
 *
 * Composite actions pass their inputs as environment variables rather than
 * INPUT_*, so there is no need for @actions/core here; this is the whole
 * surface, and keeping it dependency-free keeps the install step short.
 */

import { appendFileSync } from 'node:fs';

import { PublishError } from './manifest.js';

/** Emits an error annotation. Newlines must be percent-encoded to survive. */
export function annotate(message) {
  const encoded = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::error::${encoded}\n`);
}

/** Appends `key=value` to the runner's step-output file when running in CI. */
export function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  // Heredoc form so values containing newlines or `=` survive intact.
  const delimiter = `kb_${key}_${Math.random().toString(36).slice(2)}`;
  appendFileSync(file, `${key}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** Appends markdown to the run's job summary, when there is one. */
export function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
}

/**
 * Runs an action body, turning a PublishError into an annotation and exit 1.
 *
 * A PublishError is something the consuming repo can fix, so it is reported as
 * a message and nothing else. Anything else is a bug in the action and keeps its
 * stack trace, because that is who needs to read it.
 */
export function run(main) {
  try {
    main();
  } catch (err) {
    if (err instanceof PublishError) {
      annotate(err.message);
      process.exit(1);
    }
    throw err;
  }
}
