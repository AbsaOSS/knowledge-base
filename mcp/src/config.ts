// Command line and environment → one validated, frozen Config. Nothing else in the
// server reads process.argv or process.env.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

export type Backend = 'memory';
export const BACKENDS: readonly Backend[] = ['memory'];

export interface Config {
  mode: 'http' | 'stdio';
  backend: Backend;
  indexPath: string;
  host: string;
  port: number;
  /** `https://host` the site is served from, for absolute links. */
  publicOrigin: string | undefined;
  allowedOrigins: string[];
  trustedProxies: number;
}

type Env = Record<string, string | undefined>;

function parsePublicOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('KB_MCP_PUBLIC_ORIGIN must be an http(s) origin without a path');
  }
  return value;
}

function parseInteger(name: string, value: string, { min, max }: { min: number; max: number }): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function parseBackend(value: string): Backend {
  const backend = BACKENDS.find((candidate) => candidate === value);
  if (!backend) throw new Error(`KB_MCP_BACKEND must be one of: ${BACKENDS.join(', ')}`);
  return backend;
}

const list = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Flags win over environment variables. `defaultIndex` is where the build puts the search index
 * relative to the server bundle.
 */
export function loadConfig(argv: string[], env: Env, defaultIndex: string): Readonly<Config> {
  const { values } = parseArgs({
    args: argv,
    options: {
      stdio: { type: 'boolean', default: false },
      http: { type: 'boolean', default: false },
      index: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
    },
    strict: true,
  });
  return Object.freeze({
    mode: values.stdio ? 'stdio' : 'http',
    backend: parseBackend(env.KB_MCP_BACKEND ?? 'memory'),
    indexPath: resolve(values.index ?? env.KB_MCP_SEARCH_INDEX ?? defaultIndex),
    host: values.host ?? env.KB_MCP_HOST ?? '127.0.0.1',
    port: parseInteger('KB_MCP_PORT', values.port ?? env.KB_MCP_PORT ?? '8081', { min: 0, max: 65_535 }),
    publicOrigin: parsePublicOrigin(env.KB_MCP_PUBLIC_ORIGIN),
    allowedOrigins: list(env.KB_MCP_ALLOWED_ORIGINS),
    trustedProxies: parseInteger('KB_MCP_TRUSTED_PROXIES', env.KB_MCP_TRUSTED_PROXIES ?? '1', {
      min: 0,
      max: 16,
    }),
  });
}
