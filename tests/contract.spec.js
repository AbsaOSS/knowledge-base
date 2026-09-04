// contract.spec.js — the artifact contract, checked against its own schema.
//
// contract/kb-docs.schema.json is the one document both publishing actions and
// this repo's build validate against, and it reaches consuming repos through a
// raw GitHub URL. A schema that does not compile, or that quietly accepts a
// manifest the build will later reject, is worse than no schema at all: the
// onboarding repo goes green and the deployment fails.
//
// These are pure assertions on the schema — no browser, no build. They live in
// the Playwright suite so `npm test` stays the single command.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';

const SCHEMA_PATH = join(process.cwd(), 'contract', 'kb-docs.schema.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

/** A fresh validator per call: Ajv caches by $id, and reuse hides compile errors. */
function validator() {
  return new Ajv({ allErrors: true, strict: false }).compile(schema);
}

/** The smallest manifest the contract calls valid. */
const minimal = () => ({
  kbVersion: '1',
  apps: [{ slug: 'my-service', name: 'My Service', description: 'What the service does.' }],
});

/** One app, every optional field populated. */
const full = () => ({
  kbVersion: '1',
  apps: [{
    slug: 'my-service',
    name: 'My Service',
    description: 'What the service does and how to use it.',
    icon: 'cube',
    tags: ['platform', 'api'],
    entryPoint: 'index.html',
    pages: [
      { title: 'Overview', path: 'index.html', order: 0 },
      { title: 'Releases', path: 'docs/releasing/index.html', order: 1, section: 'Reference' },
    ],
  }],
});

/** Applies `mutate` to the first app of a full manifest. */
function withApp(mutate) {
  const m = full();
  mutate(m.apps[0]);
  return m;
}

test.describe('kb-docs.schema.json', () => {
  test('compiles', () => {
    expect(() => validator()).not.toThrow();
  });

  test('is published at the URL consuming repos fetch it from', () => {
    // The $id is how an onboarding repo's CI finds the schema; a stale one sends
    // it to a 404 and the validation step silently degrades to a warning.
    expect(schema.$id).toBe(
      'https://raw.githubusercontent.com/AbsaOSS/knowledge-base/master/contract/kb-docs.schema.json',
    );
  });

  test('accepts the minimal and the fully populated manifest', () => {
    const validate = validator();
    expect(validate(minimal()), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(full()), JSON.stringify(validate.errors)).toBe(true);
  });

  test('accepts several apps in one bundle', () => {
    const m = minimal();
    m.apps.push({ slug: 'my-service-ops', name: 'Operations', description: 'Running it in production.' });
    expect(validator()(m)).toBe(true);
  });
});

test.describe('kb-docs.schema.json rejects', () => {
  const cases = [
    ['a numeric kbVersion', { ...minimal(), kbVersion: 1 }],
    ['an unknown kbVersion', { ...minimal(), kbVersion: '2' }],
    ['a missing kbVersion', { apps: minimal().apps }],
    ['an empty apps list', { kbVersion: '1', apps: [] }],
    ['a missing apps list', { kbVersion: '1' }],
    ['an unknown top-level field', { ...minimal(), type: 'single-page' }],

    ['an upper-case slug', withApp(a => { a.slug = 'My-Service'; })],
    ['an underscored slug', withApp(a => { a.slug = 'my_service'; })],
    ['a slug with a leading hyphen', withApp(a => { a.slug = '-my-service'; })],
    ['a one-character slug', withApp(a => { a.slug = 'x'; })],
    ['a missing slug', withApp(a => { delete a.slug; })],

    ['a missing name', withApp(a => { delete a.name; })],
    ['a missing description', withApp(a => { delete a.description; })],
    ['a description under 10 characters', withApp(a => { a.description = 'too short'; })],
    ['a description over 280 characters', withApp(a => { a.description = 'x'.repeat(281); })],

    ['an unknown icon', withApp(a => { a.icon = 'rocket'; })],
    ['more than five tags', withApp(a => { a.tags = ['a', 'b', 'c', 'd', 'e', 'f']; })],
    ['an unknown app field', withApp(a => { a.headless = true; })],

    // The archive is unpacked into a directory this deployment serves, so a
    // manifest must not be able to point at a file outside the app's own tree.
    ['an entryPoint that escapes the app directory', withApp(a => { a.entryPoint = '../other/index.html'; })],
    ['an absolute entryPoint', withApp(a => { a.entryPoint = '/index.html'; })],
    ['a page path that escapes the app directory', withApp(a => { a.pages[0].path = '../../etc/passwd'; })],
    ['an absolute page path', withApp(a => { a.pages[0].path = '/index.html'; })],

    ['a page with no order', withApp(a => { delete a.pages[0].order; })],
    ['a negative page order', withApp(a => { a.pages[0].order = -1; })],
    ['a non-integer page order', withApp(a => { a.pages[0].order = 1.5; })],
    ['an unknown page field', withApp(a => { a.pages[0].icon = 'cube'; })],
  ];

  for (const [label, manifest] of cases) {
    test(label, () => {
      expect(validator()(manifest)).toBe(false);
    });
  }
});
