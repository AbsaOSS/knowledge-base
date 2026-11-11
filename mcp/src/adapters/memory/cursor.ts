// Offset cursors for the in-memory adapters. A cursor carries a fingerprint of the query
// and search index it was issued for, so it cannot be replayed against different results.
import { createHash } from 'node:crypto';
import { InvalidCursorError } from '../../domain.ts';

const CURSOR_VERSION = 1;

/** Short, stable fingerprint of whatever identifies a result list. */
export const fingerprint = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 8);

export const encodeCursor = (offset: number, print: string): string =>
  Buffer.from(JSON.stringify({ v: CURSOR_VERSION, h: print, o: offset })).toString('base64url');

/** The offset a cursor points at; 0 when there is none. Throws InvalidCursorError. */
export function decodeCursor(cursor: string | undefined, print: string): number {
  if (!cursor) return 0;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  } catch {
    throw new InvalidCursorError();
  }
  const { v, h, o } = (data ?? {}) as { v?: unknown; h?: unknown; o?: unknown };
  if (v !== CURSOR_VERSION || h !== print || typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
    throw new InvalidCursorError();
  }
  return o;
}

/** One page of `items` starting at the cursor, with the cursor for the next page if any. */
export function paginate<T>(
  items: readonly T[],
  { cursor, limit }: { cursor?: string | undefined; limit: number },
  print: string,
): { items: T[]; total: number; nextCursor?: string } {
  const offset = decodeCursor(cursor, print);
  const end = offset + limit;
  return {
    items: items.slice(offset, end),
    total: items.length,
    ...(end < items.length ? { nextCursor: encodeCursor(end, print) } : {}),
  };
}
