/**
 * tests/build-image-workflow.spec.js
 *
 * The "Build and push the images" step of the reusable build workflow, run for
 * real: its script is taken from .github/workflows/build-image.yml and executed
 * the way Actions runs a `run:` block (bash -e -o pipefail), with a stub
 * `docker` that records every call and fails the one a test names.
 *
 * What matters is what reaches the registry. A failed build must fail the step
 * and push nothing, and the site and MCP images are one version: a run that
 * cannot produce both must not move either one's tags.
 */

import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'build-image.yml');
const STEP = '- name: Build and push the images';

const SITE = 'registry.example/knowledge-base';
const MCP = 'registry.example/knowledge-base-mcp';

/** The step's `run: |` block, dedented. */
function stepScript() {
  const lines = readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const runAt = lines.findIndex((line, i) => i > lines.findIndex((l) => l.includes(STEP)) && /^\s+run: \|$/.test(line));
  expect(runAt, `${STEP} has a run block`).toBeGreaterThan(0);
  const indent = lines[runAt + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** Git for Windows' bash, not the WSL launcher in System32. */
function findBash() {
  if (process.platform === 'win32') {
    const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (existsSync(gitBash)) return gitBash;
  }
  return 'bash';
}

/**
 * Runs the step. `fail` is a substring of the docker command line that makes
 * the stub exit 1, e.g. `build -f mcp-server/Dockerfile`.
 */
function runStep({ mcp = true, fail = '', pythonIndex = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-build-image-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const stub = join(bin, 'docker');
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'printf \'%s\\n\' "$*" >> "$DOCKER_LOG"',
      'if [ -n "${DOCKER_FAIL:-}" ] && [[ "$*" == *"$DOCKER_FAIL"* ]]; then exit 1; fi',
      '',
    ].join('\n'),
  );
  chmodSync(stub, 0o755);
  const script = join(dir, 'step.sh');
  writeFileSync(script, stepScript());
  const files = { log: join(dir, 'docker.log'), output: join(dir, 'output'), summary: join(dir, 'summary') };
  for (const file of Object.values(files)) writeFileSync(file, '');

  try {
    const result = spawnSync(findBash(), ['--noprofile', '--norc', '-eo', 'pipefail', script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        DOCKER_LOG: files.log,
        DOCKER_FAIL: fail,
        GITHUB_OUTPUT: files.output,
        GITHUB_STEP_SUMMARY: files.summary,
        KB_IMAGE: SITE,
        KB_MCP_IMAGE: mcp ? MCP : '',
        KB_TAGS: 'abc123,latest',
        KB_SHA: 'abc123',
        KB_CA_CERTIFICATES: '',
        KB_PYTHON_INDEX: pythonIndex,
        KB_PYTHON_INDEX_USERNAME: '',
        KB_PYTHON_INDEX_TOKEN: '',
      },
    });
    const read = (file) => readFileSync(file, 'utf8');
    const docker = read(files.log).split('\n').filter(Boolean);
    return {
      status: result.status,
      stderr: result.stderr,
      builds: docker.filter((line) => line.startsWith('build ')),
      pushes: docker.filter((line) => line.startsWith('push ')).map((line) => line.slice('push '.length)),
      output: read(files.output),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.describe('build-image.yml: build and push the images', () => {
  test('builds both images under every tag, then pushes both and reports the first tag', () => {
    const run = runStep();

    expect(run.status, run.stderr).toBe(0);
    expect(run.builds).toHaveLength(2);
    expect(run.pushes.sort()).toEqual([`${MCP}:abc123`, `${MCP}:latest`, `${SITE}:abc123`, `${SITE}:latest`].sort());
    expect(run.output).toContain(`image=${SITE}:abc123\n`);
    expect(run.output).toContain(`mcp-image=${MCP}:abc123\n`);
  });

  test('without an MCP image name only the site image is built and pushed', () => {
    const run = runStep({ mcp: false });

    expect(run.status, run.stderr).toBe(0);
    expect(run.builds).toHaveLength(1);
    expect(run.pushes).toEqual([`${SITE}:abc123`, `${SITE}:latest`]);
    expect(run.output).not.toContain('mcp-image=');
  });

  test('a failed site build fails the step and pushes nothing', () => {
    const run = runStep({ fail: 'build -f Dockerfile' });

    expect(run.status).not.toBe(0);
    expect(run.pushes).toEqual([]);
    expect(run.output).toBe('');
  });

  test('a failed MCP build leaves the site image unpushed too', () => {
    const run = runStep({ fail: 'build -f mcp-server/Dockerfile' });

    expect(run.status).not.toBe(0);
    expect(run.pushes).toEqual([]);
    expect(run.output).toBe('');
  });

  test('a refused MCP push leaves the site tags where they were', () => {
    const run = runStep({ fail: `push ${MCP}:` });

    expect(run.status).not.toBe(0);
    expect(run.pushes.filter((ref) => ref.startsWith(`${SITE}:`))).toEqual([]);
    expect(run.output).not.toContain('image=');
  });

  test('a python-index carrying credentials is refused before anything is built', () => {
    const run = runStep({ pythonIndex: 'https://user:secret@pypi.example/simple' });

    expect(run.status).not.toBe(0);
    expect(run.builds).toEqual([]);
    expect(run.pushes).toEqual([]);
  });
});
