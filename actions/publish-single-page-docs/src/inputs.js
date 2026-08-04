/**
 * inputs.js — parse and validate the `docs` input of the publish-docs action.
 *
 * Every failure here is a mistake in the *onboarding repo's* workflow file, so
 * messages name the offending entry and say exactly what to change. They are
 * collected and reported together rather than one-at-a-time, so a repo does not
 * need one CI run per typo.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import YAML from 'yaml';

/** Icon set — kept in sync with contract/schema.json. */
export const ICONS = [
  'book-open', 'cube', 'chip', 'chart-bar', 'shield',
  'cog', 'terminal', 'globe', 'layers', 'lightning-bolt',
  'document', 'collection', 'puzzle', 'database',
];

export const DEFAULT_ICON = 'book-open';

/** Same rule as contract/schema.json, minus leading/trailing/double hyphens. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 280;
const MAX_TITLE = 128;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 32;

/** Thrown for any invalid input; `.problems` holds one line per issue. */
export class InputError extends Error {
  constructor(problems) {
    super(
      'The `docs` input is not valid:\n' +
      problems.map((p) => '  • ' + p).join('\n') +
      '\n\nSee contract/SINGLE_PAGE.md for the expected shape.',
    );
    this.name = 'InputError';
    this.problems = problems;
  }
}

/**
 * Parses the raw `docs` input. Accepts YAML (which is a superset of JSON), so a
 * workflow may use either a YAML block scalar or an inline JSON array.
 */
export function parseDocsInput(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new InputError(['`docs` is empty — provide a YAML or JSON list of doc definitions.']);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new InputError([`\`docs\` is not valid YAML/JSON: ${err.message}`]);
  }

  if (!Array.isArray(parsed)) {
    throw new InputError([
      '`docs` must be a LIST of doc definitions, got ' +
      (parsed === null ? 'nothing' : typeof parsed) +
      '. Start each entry with "- md: …".',
    ]);
  }
  if (parsed.length === 0) {
    throw new InputError(['`docs` is an empty list — declare at least one doc.']);
  }
  return parsed;
}

/** True when `p` stays inside `root` (no `..` escape, no absolute path). */
function isInsideWorkspace(root, p) {
  if (isAbsolute(p)) return false;
  const rel = relative(root, join(root, normalize(p)));
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..';
}

/**
 * Validates the parsed list against the contract and returns normalised docs.
 *
 * @param {Array}  docs      - output of parseDocsInput
 * @param {string} workspace - repo checkout root; `md` paths are resolved against it
 * @returns {Array<{md: string, mdAbs: string, title: string, description: string,
 *                  slug: string, icon: string, tags: string[]}>}
 */
export function validateDocs(docs, workspace) {
  const problems = [];
  const seenSlugs = new Map();
  const normalised = [];

  docs.forEach((doc, i) => {
    // `docs[0]` is how the entry is addressed in messages; authors count from the
    // top of their own list, so keep the index zero-based and mention the slug.
    const label = (extra) => `docs[${i}]${extra ? ` (${extra})` : ''}`;

    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      problems.push(`${label()}: expected a mapping with md/title/description/slug, got ${Array.isArray(doc) ? 'a list' : typeof doc}.`);
      return;
    }

    const where = label(typeof doc.slug === 'string' ? `slug: ${doc.slug}` : '');
    const known = ['md', 'title', 'description', 'slug', 'icon', 'tags'];
    for (const key of Object.keys(doc)) {
      if (!known.includes(key)) {
        problems.push(`${where}: unknown field "${key}" — allowed fields are ${known.join(', ')}.`);
      }
    }

    // ── slug ──
    let slug = null;
    if (typeof doc.slug !== 'string' || doc.slug.trim() === '') {
      problems.push(`${where}: "slug" is required (lowercase kebab-case, e.g. "my-service").`);
    } else {
      slug = doc.slug.trim();
      if (!SLUG_RE.test(slug)) {
        problems.push(`${where}: slug "${slug}" is invalid — use lowercase letters, digits and single hyphens only (e.g. "my-service").`);
      } else if (slug.length < 2 || slug.length > 32) {
        problems.push(`${where}: slug "${slug}" must be 2–32 characters long.`);
      } else if (seenSlugs.has(slug)) {
        problems.push(`${where}: slug "${slug}" is already used by docs[${seenSlugs.get(slug)}] — each doc needs its own slug.`);
      } else {
        seenSlugs.set(slug, i);
      }
    }

    // ── md ──
    let mdAbs = null;
    if (typeof doc.md !== 'string' || doc.md.trim() === '') {
      problems.push(`${where}: "md" is required — the path to the markdown file, relative to the repository root (e.g. "docs/overview.md").`);
    } else {
      const md = doc.md.trim();
      if (!isInsideWorkspace(workspace, md)) {
        problems.push(`${where}: md "${md}" must be a repository-relative path inside the checkout (no leading "/" and no "..").`);
      } else {
        mdAbs = join(workspace, normalize(md));
        if (!existsSync(mdAbs)) {
          problems.push(`${where}: md "${md}" does not exist in the repository — check the path, and that the workflow runs actions/checkout first.`);
        } else if (!statSync(mdAbs).isFile()) {
          problems.push(`${where}: md "${md}" is a directory — point it at a single markdown file.`);
        }
      }
    }

    // ── title ──
    let title = null;
    if (typeof doc.title !== 'string' || doc.title.trim() === '') {
      problems.push(`${where}: "title" is required — the name shown in the knowledge base catalog.`);
    } else if (doc.title.trim().length > MAX_TITLE) {
      problems.push(`${where}: title is ${doc.title.trim().length} characters — keep it under ${MAX_TITLE}.`);
    } else {
      title = doc.title.trim();
    }

    // ── description ──
    let description = null;
    if (typeof doc.description !== 'string' || doc.description.trim() === '') {
      problems.push(`${where}: "description" is required — one sentence shown on the catalog card.`);
    } else {
      description = doc.description.trim();
      if (description.length < MIN_DESCRIPTION || description.length > MAX_DESCRIPTION) {
        problems.push(`${where}: description is ${description.length} characters — it must be ${MIN_DESCRIPTION}–${MAX_DESCRIPTION}.`);
      }
    }

    // ── icon ──
    let icon = DEFAULT_ICON;
    if (doc.icon !== undefined && doc.icon !== null) {
      if (typeof doc.icon !== 'string' || !ICONS.includes(doc.icon)) {
        problems.push(`${where}: icon "${doc.icon}" is not supported — pick one of: ${ICONS.join(', ')}.`);
      } else {
        icon = doc.icon;
      }
    }

    // ── tags ──
    let tags = [];
    if (doc.tags !== undefined && doc.tags !== null) {
      if (!Array.isArray(doc.tags)) {
        problems.push(`${where}: "tags" must be a list of short strings.`);
      } else if (doc.tags.length > MAX_TAGS) {
        problems.push(`${where}: ${doc.tags.length} tags — at most ${MAX_TAGS} are allowed.`);
      } else if (doc.tags.some((t) => typeof t !== 'string' || t.trim() === '' || t.length > MAX_TAG_LENGTH)) {
        problems.push(`${where}: every tag must be a non-empty string of at most ${MAX_TAG_LENGTH} characters.`);
      } else {
        tags = doc.tags.map((t) => t.trim());
      }
    }

    if (slug && mdAbs && title && description) {
      normalised.push({ md: doc.md.trim(), mdAbs, title, description, slug, icon, tags });
    }
  });

  if (problems.length > 0) throw new InputError(problems);
  return normalised;
}
