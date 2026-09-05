/**
 * tests/skill.spec.js
 *
 * `skills/kb-docs-add/` is the agent-facing path through the onboarding contract:
 * a SKILL.md that Claude Code, GitHub Copilot and `npx skills add` all read, plus
 * references and copy-paste examples. Two things keep it honest, and nothing else
 * exercises either:
 *
 *   1. The examples are the contract's own code blocks, byte for byte. A skill that
 *      carried its own copy of the workflow would drift the first time the contract
 *      changed, and an agent would then write the stale version into a real repo.
 *   2. The frontmatter satisfies the Agent Skills spec every consumer validates
 *      against (name ↔ directory, lengths, character set), so an install that
 *      succeeds on one agent does not fail on another.
 *
 * Static assertions; no network.
 */

import { test, expect } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_DIR = 'skills/kb-docs-add';
const SKILL_NAME = 'kb-docs-add';

// A CRLF checkout (the Git for Windows default) must not break the `\n`-anchored
// comparisons below.
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** First fenced block of `lang` after `heading`, as the contract prints it. */
function fencedBlockAfter(markdown, heading, lang) {
  const at = markdown.indexOf(heading);
  expect(at, `heading ${JSON.stringify(heading)} not found`).toBeGreaterThanOrEqual(0);
  const m = markdown.slice(at).match(new RegExp('```' + lang + '\\n([\\s\\S]*?)\\n```'));
  expect(m, `no ${lang} block after ${JSON.stringify(heading)}`).not.toBeNull();
  return m[1] + '\n';
}

function frontmatter(markdown) {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  expect(m, 'SKILL.md must open with a YAML frontmatter block').not.toBeNull();
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: markdown.slice(m[0].length) };
}

/** Every "name/with/slashes.md"-looking path mentioned in SKILL.md, resolved to the skill dir. */
function referencedPaths(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/`((?:references|examples)\/[A-Za-z0-9._-]+)`/g)) out.add(m[1]);
  return [...out];
}

test.describe('SKILL.md frontmatter satisfies the Agent Skills spec', () => {
  const { fields, body } = frontmatter(read(`${SKILL_DIR}/SKILL.md`));

  test('name matches the directory and the spec character set', () => {
    expect(fields.name).toBe(SKILL_NAME);
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.name.length).toBeLessThanOrEqual(64);
  });

  test('description is present, within 1024 characters, and names the triggers', () => {
    expect(fields.description).toBeTruthy();
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    for (const trigger of ['knowledge base', 'kb-docs.json', 'kb-docs.tar.gz', 'publish-single-page-docs', 'publish-docs']) {
      expect(fields.description, `description should mention ${trigger}`).toContain(trigger);
    }
  });

  test('only portable frontmatter fields are used', () => {
    // `allowed-tools` is Claude-only and experimental; a skill installed into
    // .github/skills must not depend on it.
    const portable = new Set(['name', 'description', 'license', 'compatibility', 'metadata']);
    for (const key of Object.keys(fields)) {
      if (key === 'author' || key === 'source') continue; // nested under metadata
      expect(portable.has(key), `frontmatter field "${key}" is not in the spec`).toBe(true);
    }
  });

  test('body stays short enough to load whole; detail lives in references/', () => {
    const lines = body.split('\n').length;
    expect(lines).toBeLessThanOrEqual(160);
  });
});

test.describe('the skill is guidance only', () => {
  test('ships no scripts/ directory and no executable code', () => {
    expect(existsSync(join(ROOT, SKILL_DIR, 'scripts'))).toBe(false);
    const walk = (dir) =>
      readdirSync(join(ROOT, dir)).flatMap((name) => {
        const rel = `${dir}/${name}`;
        return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
      });
    const code = walk(SKILL_DIR).filter((f) => /\.(js|mjs|cjs|ts|py|sh|ps1)$/.test(f));
    expect(code, 'the actions own every check; the skill only points at them').toEqual([]);
  });

  test('every references/ and examples/ path SKILL.md names exists', () => {
    const skill = read(`${SKILL_DIR}/SKILL.md`);
    const mentioned = referencedPaths(skill);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const rel of mentioned) {
      expect(existsSync(join(ROOT, SKILL_DIR, rel)), `${rel} is referenced but missing`).toBe(true);
    }
    for (const required of ['references/single-page.md', 'references/packaged.md', 'references/troubleshooting.md']) {
      expect(mentioned, `SKILL.md must point the agent at ${required}`).toContain(required);
    }
  });

  test('never names a pre-v1 artifact as something to produce', () => {
    // The strings may appear as things to *avoid*; they must not appear in an example.
    for (const file of readdirSync(join(ROOT, SKILL_DIR, 'examples'))) {
      const text = read(`${SKILL_DIR}/examples/${file}`);
      for (const legacy of ['dist.tar.gz', 'marketplace.json', 'bundle.json', 'data-mp-headless', '@master']) {
        expect(text, `${file} contains ${legacy}`).not.toContain(legacy);
      }
    }
  });
});

test.describe('examples are the contract, verbatim', () => {
  const singlePage = read('contract/SINGLE_PAGE.md');
  const headless = read('contract/HEADLESS_RULES.md');

  const CASES = [
    ['examples/single-page.publish-docs.yml', singlePage, '## 1. Add the workflow', 'yaml'],
    ['examples/packaged.publish-docs.yml', headless, '## Required: GitHub Release artifact', 'yaml'],
    ['examples/kb-docs.json', headless, '## Required: `kb-docs.json` manifest', 'json'],
  ];

  for (const [example, source, heading, lang] of CASES) {
    test(`${example} equals the block under ${JSON.stringify(heading)}`, () => {
      expect(read(`${SKILL_DIR}/${example}`)).toBe(fencedBlockAfter(source, heading, lang));
    });
  }

  test('references/packaged.md carries the brand token values STYLE_GUIDE.md fixes', () => {
    // The packaged reference hands the agent a paste-ready :root block, because a docs
    // repo rarely has this repository checked out beside it. The brand hexes in that
    // block must be the ones the style guide's palette table names.
    const styleGuide = read('contract/STYLE_GUIDE.md');
    const packaged = read(`${SKILL_DIR}/references/packaged.md`);
    for (const token of ['--color-kb-500', '--color-kb-600']) {
      const row = styleGuide.match(new RegExp('\\| `' + token + '`\\s*\\| `(#[0-9a-f]{6})`'));
      expect(row, `${token} missing from the STYLE_GUIDE palette table`).not.toBeNull();
      expect(packaged, `${token} should be ${row[1]} in packaged.md`).toMatch(new RegExp(token + ':\\s*' + row[1]));
    }
    // Page background and heading colour derive from kb-25 and kb-950 in knowledge-base.css.
    expect(packaged).toMatch(/--bg-page:\s*#fdf8f9/);
    expect(packaged).toMatch(/--text-heading:\s*#1b0e12/);
  });

  test('the manifest example validates as JSON with kbVersion "1"', () => {
    const manifest = JSON.parse(read(`${SKILL_DIR}/examples/kb-docs.json`));
    expect(manifest.kbVersion).toBe('1');
    expect(Array.isArray(manifest.apps) && manifest.apps.length).toBeTruthy();
  });
});

test.describe('the docs point at the skill', () => {
  const INSTALL = 'npx skills add AbsaOSS/knowledge-base';
  for (const rel of ['README.md', 'contract/SINGLE_PAGE.md', 'contract/HEADLESS_RULES.md']) {
    test(`${rel} names ${SKILL_NAME} and the install command`, () => {
      const text = read(rel);
      expect(text).toContain(SKILL_NAME);
      expect(text).toContain(INSTALL);
    });
  }
});
