// Stateless, read-only MCP over HTTP: guards, limits, then one MCP server per request.
// The Host header needs no validation: the listener is loopback only and the data public.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { ServerFactory } from '../protocol/server.ts';
import { sendBrowserError } from './error-page.ts';
import { RateLimiter } from './rate-limit.ts';
import type { RateLimits } from './rate-limit.ts';
import { BodyTooLargeError, clientAddress, loggableMethod, mediaType, readBody } from './request.ts';

export interface HttpLimits extends RateLimits {
  maxInFlight: number;
  maxBodyBytes: number;
  timeoutMs: number;
}

export interface HttpOptions {
  /** Browser origins allowed to call the endpoint. A request without Origin (an agent) is always allowed. */
  allowedOrigins?: readonly string[];
  /** Proxies in front of this process that append to X-Forwarded-For; 1 = nginx. */
  trustedProxies?: number;
  limits?: Partial<HttpLimits>;
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export const DEFAULT_LIMITS: HttpLimits = {
  rps: 20,
  burst: 40,
  globalRps: 200,
  globalBurst: 400,
  maxClients: 10_000,
  maxInFlight: 32,
  maxBodyBytes: 65_536,
  timeoutMs: 10_000,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '600',
};
const RETRY = { 'Retry-After': '1' };

const PARSE_ERROR = -32700;
const SERVER_ERROR = -32000;

function sendRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
  code = SERVER_ERROR,
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

function logRequest(res: ServerResponse, body: unknown, start: number): void {
  try {
    process.stderr.write(
      `kb-mcp ${new Date().toISOString()} ${res.statusCode || 200} ${loggableMethod(body)} ${Date.now() - start}ms\n`,
    );
  } catch {
    // Logging must never fail a request.
  }
}

export function createMcpHttpHandler(createServer: ServerFactory, options: HttpOptions = {}): HttpHandler {
  const { allowedOrigins = [], trustedProxies = 1 } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const limiter = new RateLimiter(limits);
  let inFlight = 0;

  /** One JSON-RPC exchange through a fresh server and transport. */
  async function dispatch(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = createServer();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const timeout = setTimeout(() => {
      if (!res.writableEnded) sendRpcError(res, 503, 'Request timed out', RETRY);
    }, limits.timeoutMs);
    try {
      await transport.handleRequest(req, res, body);
      await transport.close();
      await server.close();
    } finally {
      clearTimeout(timeout);
    }
  }

  return async (req, res) => {
    const start = Date.now();
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const allowedOrigin = Boolean(origin) && allowedOrigins.includes(origin ?? '');
    if (allowedOrigin) {
      res.setHeader('Vary', 'Origin');
      for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);
    }

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.setHeader('Allow', 'POST');
      sendBrowserError(req, res, 405);
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }
    if (origin && !allowedOrigin) {
      sendRpcError(res, 403, 'Origin not allowed');
      return;
    }
    if (mediaType(req) !== 'application/json') {
      sendRpcError(res, 415, 'Content-Type must be application/json');
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, limits.maxBodyBytes));
    } catch (error) {
      if (error instanceof BodyTooLargeError) sendRpcError(res, 413, 'Request body too large');
      else sendRpcError(res, 400, 'Parse error', {}, PARSE_ERROR);
      return;
    }
    if (!limiter.allow(clientAddress(req, trustedProxies))) {
      sendRpcError(res, 429, 'Rate limit exceeded', RETRY);
      return;
    }
    if (inFlight >= limits.maxInFlight) {
      sendRpcError(res, 503, 'Server busy', RETRY);
      return;
    }

    inFlight += 1;
    try {
      await dispatch(req, res, body);
    } catch {
      if (!res.writableEnded) sendRpcError(res, 500, 'Internal server error');
    } finally {
      inFlight -= 1;
      if (!res.writableEnded) res.end();
      logRequest(res, body, start);
    }
  };
}
