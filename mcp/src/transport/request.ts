// Reading what an HTTP request says about itself, defensively: everything here is
// client-controlled.
import type { IncomingMessage } from 'node:http';

export class BodyTooLargeError extends Error {
  override name = 'BodyTooLargeError';
}

/** The request body as text; rejects with BodyTooLargeError past `cap` bytes. */
export function readBody(req: IncomingMessage, cap: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (part: Buffer) => {
      if (rejected) return;
      size += part.length;
      if (size > cap) {
        rejected = true;
        reject(new BodyTooLargeError('Request body too large'));
      } else {
        parts.push(part);
      }
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(parts).toString());
    });
    req.on('error', reject);
  });
}

/** The client address `trustedProxies` hops from the right of X-Forwarded-For; entries further left are client-supplied. */
export function clientAddress(req: IncomingMessage, trustedProxies: number): string {
  const forwarded = req.headers['x-forwarded-for'];
  const hops = String(forwarded ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const address = trustedProxies > 0 && hops.length >= trustedProxies ? hops[hops.length - trustedProxies] : undefined;
  return address ?? req.socket.remoteAddress ?? 'unknown';
}

/** The media type of the request, lower-cased, without parameters. */
export const mediaType = (req: IncomingMessage): string =>
  (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';

/** The JSON-RPC method for logs: client-controlled, so never interpolated unchecked. */
export function loggableMethod(body: unknown): string {
  const method = typeof body === 'object' && body !== null ? (body as { method?: unknown }).method : undefined;
  return typeof method === 'string' && /^[\w./-]{1,64}$/.test(method) ? method : 'unknown';
}
