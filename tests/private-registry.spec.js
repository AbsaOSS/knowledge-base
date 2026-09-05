/**
 * tests/private-registry.spec.js
 *
 * Consuming repositories may run on runners inside a private network: no route
 * to registry.npmjs.org, every package served by an internal mirror. The three
 * shared CI pieces — both publishing actions and the reusable build workflow —
 * cover that with one mechanism, and this file pins the parts of it nothing
 * else exercises. Static assertions plus the shell script; no network.
 *
 * The lockfile rule matters most. npm rewrites a `resolved` host to the
 * configured registry only when that host is the default one
 * (`replace-registry-host`, default `npmjs`). A lockfile regenerated behind a
 * corporate `~/.npmrc` carries that registry's URLs instead, npm does not
 * rewrite those, and the lockfile then installs in exactly one network. It
 * would still pass every other test here.
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NPMJS = 'https://registry.npmjs.org/';
const SCRIPT = join(ROOT, 'actions', 'lib', 'npm-registry.sh');

const LOCKFILES = ['package-lock.json', 'actions/package-lock.json'];

const ACTIONS = ['actions/publish-docs/action.yml', 'actions/publish-single-page-docs/action.yml'];
const WORKFLOW = '.github/workflows/build-image.yml';

/** The inputs every consumer-facing manifest has to offer, by the same names. */
const INPUTS = ['npm-registry', 'npm-token', 'node-mirror', 'node-mirror-token'];

// A CRLF checkout (the Git for Windows default) must not break the `\n`-anchored
// assertions below.
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test.describe('lockfiles resolve to the public registry', () => {
  for (const rel of LOCKFILES) {
    test(`${rel}: every package resolves to ${NPMJS} and carries an integrity hash`, () => {
      const lock = JSON.parse(read(rel));
      expect(lock.lockfileVersion).toBeGreaterThanOrEqual(2);

      const offenders = [];
      for (const [path, pkg] of Object.entries(lock.packages)) {
        if (path === '' || pkg.link || pkg.inBundle) continue;
        if (typeof pkg.resolved !== 'string' || !pkg.resolved.startsWith(NPMJS)) {
          offenders.push(`${path}: resolved=${pkg.resolved}`);
        } else if (typeof pkg.integrity !== 'string' || pkg.integrity === '') {
          offenders.push(`${path}: no integrity`);
        }
      }
      expect(offenders, 'regenerate with --registry=https://registry.npmjs.org/').toEqual([]);
    });
  }
});

test.describe('the private-registry inputs exist on every shared CI piece', () => {
  for (const rel of ACTIONS) {
    test(`${rel} declares the inputs and installs through the shared script`, () => {
      const text = read(rel);
      for (const input of INPUTS) expect(text).toContain(`\n  ${input}:\n`);
      expect(text).toContain('lib/npm-registry.sh');
      expect(text).toContain('KB_NPM_REGISTRY: ${{ inputs.npm-registry }}');
      // Both the step that writes the .npmrc and the install that reads it.
      expect(text.split('KB_NPM_TOKEN: ${{ inputs.npm-token }}').length - 1).toBe(2);
      expect(text).toContain('mirror: ${{ inputs.node-mirror }}');
      expect(text).toContain('mirror-token: ${{ inputs.node-mirror-token }}');
    });
  }

  test(`${WORKFLOW} declares the inputs, the secrets and a configurable runner`, () => {
    const text = read(WORKFLOW);
    for (const input of ['runs-on', 'npm-registry', 'node-mirror']) {
      expect(text).toContain(`\n      ${input}:\n`);
    }
    for (const secret of ['npm-token', 'node-mirror-token']) {
      expect(text).toContain(`\n      ${secret}:\n`);
    }
    expect(text).toContain('KB_NPM_REGISTRY: ${{ inputs.npm-registry }}');
    expect(text.split('KB_NPM_TOKEN: ${{ secrets.npm-token }}').length - 1).toBe(2);
    expect(text).toContain('mirror: ${{ inputs.node-mirror }}');
    expect(text).toContain('mirror-token: ${{ secrets.node-mirror-token }}');
    expect(text).toMatch(/runs-on: \$\{\{ .*fromJSON\(inputs\.runs-on\).*inputs\.runs-on \}\}/);
    // The workflow inlines the script's logic; keep the two token lines identical
    // so a fix to one cannot silently miss the other.
    expect(text).toContain('echo "${registry#*:}:_authToken=\\${KB_NPM_TOKEN}"');
    expect(read('actions/lib/npm-registry.sh')).toContain(
      'echo "${auth_key}:_authToken=\\${KB_NPM_TOKEN}"',
    );
  });
});

/**
 * Git for Windows ships the bash the script is written for; the WSL launcher in
 * System32 is also called bash and must not be picked up by accident.
 */
function findBash() {
  if (process.platform === 'win32') {
    const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

test.describe('actions/lib/npm-registry.sh', () => {
  const BASH = findBash();
  const hasBash = spawnSync(BASH, ['-c', 'exit 0']).status === 0;

  /** Runs the script against a throwaway directory and returns what it did. */
  function run(env) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-npmrc-'));
    try {
      // Git bash accepts a drive-letter path as long as the separators are its own.
      const result = spawnSync(BASH, [SCRIPT, dir.replace(/\\/g, '/')], {
        env: { PATH: process.env.PATH, ...env },
        encoding: 'utf8',
      });
      const file = join(dir, '.npmrc');
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        npmrc: existsSync(file) ? readFileSync(file, 'utf8') : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test.skip(!hasBash, 'needs bash');

  test('writes nothing when no registry is given', () => {
    const { status, npmrc } = run({});
    expect(status).toBe(0);
    expect(npmrc).toBeNull();
  });

  test('normalises the URL to one trailing slash and writes only the registry', () => {
    const { status, stdout, npmrc } = run({
      KB_NPM_REGISTRY: 'https://artifactory.example.com/artifactory/api/npm/npm-remote',
    });
    expect(status).toBe(0);
    expect(npmrc).toBe('registry=https://artifactory.example.com/artifactory/api/npm/npm-remote/\n');
    expect(stdout).toContain('npm installs from https://artifactory.example.com/artifactory/api/npm/npm-remote/');
    expect(stdout).not.toContain('authenticated');
  });

  test('scopes the token to the registry and never writes it to disk', () => {
    const { status, stdout, npmrc } = run({
      KB_NPM_REGISTRY: 'https://artifactory.example.com/artifactory/api/npm/npm-remote/',
      KB_NPM_TOKEN: 's3cr3t-token-value',
    });
    expect(status).toBe(0);
    expect(npmrc).toBe(
      'registry=https://artifactory.example.com/artifactory/api/npm/npm-remote/\n' +
        '//artifactory.example.com/artifactory/api/npm/npm-remote/:_authToken=${KB_NPM_TOKEN}\n',
    );
    expect(npmrc).not.toContain('s3cr3t');
    expect(stdout).not.toContain('s3cr3t');
    expect(stdout).toContain('(authenticated)');
  });

  test('rejects a registry that is not an http(s) URL', () => {
    const { status, stdout, npmrc } = run({ KB_NPM_REGISTRY: 'artifactory.example.com/npm' });
    expect(status).toBe(1);
    expect(stdout).toContain('::error::npm-registry must be an http(s) URL');
    expect(npmrc).toBeNull();
  });

  test('rejects a registry that would smuggle a second line into the .npmrc', () => {
    const { status, stdout, npmrc } = run({
      KB_NPM_REGISTRY: 'https://artifactory.example.com/npm/\nalways-auth=true',
    });
    expect(status).toBe(1);
    expect(stdout).toContain('::error::npm-registry must be a single URL with no whitespace');
    expect(npmrc).toBeNull();
  });
});
