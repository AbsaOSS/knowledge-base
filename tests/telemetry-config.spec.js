import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  isTelemetryBuild, loadTelemetryConfig, shellAdapterPath, telemetryConfigPath, telemetryModulePath,
  validateTelemetryConfig,
} from '../src/utils/telemetry-config.js';

const identity = {
  enabled: true, application: 'knowledge-base', environment: 'TEST', eventNamespace: 'com.kb-test',
};

test('discovers the sidecar beside an absolute deployment registry', () => {
  expect(telemetryConfigPath('/application', { KB_REGISTRY: '/deployment/apps/dev.json' }))
    .toBe('/deployment/apps/dev.telemetry.json');
  expect(telemetryConfigPath('/application', {})).toBe('/application/apps.telemetry.json');
  expect(telemetryConfigPath('/application', { KB_TELEMETRY_CONFIG: 'custom.json' }))
    .toBe('/application/custom.json');
});

test('missing automatic sidecar disables telemetry, but an explicit missing path fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-telemetry-'));
  try {
    expect(loadTelemetryConfig(dir, {})).toBeNull();
    expect(() => loadTelemetryConfig(dir, { KB_TELEMETRY_CONFIG: 'absent.json' }))
      .toThrow('does not exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shell adapter comes from the deployment, else the built-in no-shell default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-shell-'));
  try {
    const registry = join(dir, 'dev.json');
    expect(shellAdapterPath('/application', { KB_REGISTRY: registry }))
      .toBe(resolve('src/scripts/no-shell.js'));
    writeFileSync(join(dir, 'kb-shell.mjs'), 'export function connectShell() { return null; }');
    expect(shellAdapterPath('/application', { KB_REGISTRY: registry })).toBe(join(dir, 'kb-shell.mjs'));
    expect(shellAdapterPath(dir, { KB_SHELL_ADAPTER: 'kb-shell.mjs' })).toBe(join(dir, 'kb-shell.mjs'));
    expect(() => shellAdapterPath(dir, { KB_SHELL_ADAPTER: 'absent.mjs' })).toThrow('does not exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabled configuration derives its version from KB source, not the deployment', () => {
  const config = loadTelemetryConfig(process.cwd(), {
    KB_TELEMETRY_CONFIG: 'tests/fixtures/telemetry/enabled.json',
  });
  expect(config).toMatchObject(identity);
  expect(config.version).toMatch(/^1\.0\.0\+[a-f0-9]{12}$/);
});

for (const [label, value] of [
  ['non-object', null],
  ['array', []],
  ['string flag', { ...identity, enabled: 'true' }],
  ['missing flag', { application: 'kb' }],
  ['blank application', { ...identity, application: '' }],
  ['non-string environment', { ...identity, environment: 1 }],
  ['blank namespace', { ...identity, eventNamespace: ' ' }],
  ['unknown fields', { ...identity, credentials: 'must-not-be-emitted' }],
  ['supplied version', { ...identity, version: 'not-a-source-version' }],
]) {
  test(`rejects ${label}`, () => {
    expect(() => validateTelemetryConfig(value)).toThrow(/Telemetry/);
  });
}

test('invalid JSON never leaks its content into a diagnostic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-telemetry-'));
  try {
    writeFileSync(join(dir, 'apps.telemetry.json'), 'private-content-not-json');
    expect(() => loadTelemetryConfig(dir, {})).toThrow('could not be read as JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('telemetry is compiled out unless explicitly enabled; typos fail', () => {
  expect(telemetryModulePath({})).toBe(resolve('src/scripts/telemetry-off.js'));
  expect(telemetryModulePath({ KB_TELEMETRY: '' })).toBe(resolve('src/scripts/telemetry-off.js'));
  expect(telemetryModulePath({ KB_TELEMETRY: '  ' })).toBe(resolve('src/scripts/telemetry-off.js'));
  expect(telemetryModulePath({ KB_TELEMETRY: 'true' })).toBe(resolve('src/scripts/telemetry-boot.js'));
  expect(telemetryModulePath({ KB_TELEMETRY: 'false' })).toBe(resolve('src/scripts/telemetry-off.js'));
  for (const value of ['off', '0', 'FALSE', 'no']) {
    expect(() => isTelemetryBuild({ KB_TELEMETRY: value })).toThrow('KB_TELEMETRY');
  }
});

test('the reusable workflow defaults telemetry off and forwards its input to the build', () => {
  const workflow = readFileSync('.github/workflows/build-image.yml', 'utf8').replace(/\r\n/g, '\n');
  expect(workflow).toMatch(/      telemetry:\n(?:[^\n]*\n)*?        type: boolean\n(?:[^\n]*\n)*?        default: false\n/);
  expect(workflow).toContain('KB_TELEMETRY: ${{ inputs.telemetry }}');
});
