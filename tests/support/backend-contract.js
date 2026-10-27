// The behaviour every DocumentRepository + SearchBackend pair must show, whatever stores
// the documents. A new backend gets a spec file that calls describeBackendContract() with
// a factory; the memory adapters run it in tests/mcp-backend-contract.spec.js.
//
// Ranking itself is not part of the contract — a vector backend orders results its own way —
// only its invariants are: deterministic, filtered, best first, completely pageable.
import { test, expect } from '@playwright/test';
import { EmptyQueryError, InvalidCursorError } from '../../mcp/src/domain.ts';
import { syntheticIndex } from '../fixtures/mcp/synthetic-index.js';

/** Every page of a paged call, following cursors; fails if paging does not terminate. */
async function allPages(fetchPage, limit) {
  const items = [];
  let cursor;
  for (let pages = 0; pages < 100; pages += 1) {
    const page = await fetchPage({ cursor, limit });
    expect(page.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.items);
    if (!page.nextCursor) return { items, total: page.total };
    cursor = page.nextCursor;
  }
  throw new Error('paging did not terminate');
}

const uris = (items) => items.map((item) => (item.document ?? item).uri);

/**
 * @param {string} name
 * @param {(search index: object) => Promise<{ documents: import('../../mcp/src/ports.ts').DocumentRepository,
 *   search: import('../../mcp/src/ports.ts').SearchBackend, close?: () => Promise<void> }>} create
 */
export function describeBackendContract(name, create) {
  test.describe(`backend contract: ${name}`, () => {
    let backend;
    test.beforeAll(async () => { backend = await create(syntheticIndex); });
    test.afterAll(async () => { await backend?.close?.(); });

    const canonical = [...syntheticIndex.documents]
      .sort((a, b) => a.app.localeCompare(b.app) || a.route.localeCompare(b.route))
      .map((document) => document.uri);

    test.describe('DocumentRepository', () => {
      test('apps are sorted by slug and resolvable', () => {
        const slugs = backend.documents.apps().map((app) => app.slug);
        expect(slugs).toEqual([...slugs].sort());
        expect(backend.documents.app('eventbus')?.name).toBe('Event Bus');
        expect(backend.documents.app('missing')).toBeUndefined();
      });

      test('get returns a known document whole and undefined for an unknown one', async () => {
        const document = await backend.documents.get('kb://eventbus/schemas');
        expect(document).toMatchObject({ uri: 'kb://eventbus/schemas', app: 'eventbus', title: 'Schema registry' });
        expect(document.text).toContain('Backward compatible');
        expect(await backend.documents.get('kb://missing')).toBeUndefined();
      });

      test('list pages through every document once, in canonical order', async () => {
        const { items, total } = await allPages((page) => backend.documents.list({}, page), 2);
        expect(uris(items)).toEqual(canonical);
        expect(total).toBe(canonical.length);
      });

      test('list filters by app, tag (any case) and title substring (any case)', async () => {
        const list = async (filter) => uris((await backend.documents.list(filter, { limit: 100 })).items);
        expect(await list({ app: 'eventbus' })).toEqual(['kb://eventbus', 'kb://eventbus/schemas']);
        expect(await list({ tag: 'REFERENCE' })).toEqual(['kb://eventbus/schemas']);
        expect(await list({ title: 'handBOOK' })).toEqual(['kb://service-accounts/ops/handbook']);
        expect(await list({ app: 'eventbus', tag: 'identity' })).toEqual([]);
      });

      test('a cursor is rejected for another filter, and garbage is rejected', async () => {
        const first = await backend.documents.list({}, { limit: 2 });
        await expect(backend.documents.list({ app: 'eventbus' }, { cursor: first.nextCursor, limit: 2 })).rejects.toThrow(InvalidCursorError);
        await expect(backend.documents.list({}, { cursor: 'garbage', limit: 2 })).rejects.toThrow(InvalidCursorError);
      });
    });

    test.describe('SearchBackend', () => {
      const search = (query, page = { limit: 25 }) => backend.search.search(query, page);

      test('finds the obvious document first', async () => {
        const { items } = await search({ text: 'rotate service account passwords' });
        expect(items[0].document.uri).toBe('kb://service-accounts/password-rotation');
      });

      test('results are best first, deterministic, and carry an excerpt and a real section', async () => {
        const first = await search({ text: 'events schema consumers' });
        expect(first.items.length).toBeGreaterThan(1);
        const scores = first.items.map((hit) => hit.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(await search({ text: 'events schema consumers' })).toEqual(first);
        for (const hit of first.items) {
          expect(hit.excerpt.length).toBeGreaterThan(0);
          if (hit.section) expect(hit.document.sections.map((section) => section.heading)).toContain(hit.section.heading);
        }
      });

      test('filters by app and tag', async () => {
        const byApp = await search({ text: 'release events rotation', app: 'eventbus' });
        expect(byApp.items.every((hit) => hit.document.app === 'eventbus')).toBe(true);
        const byTag = await search({ text: 'release events rotation', tag: 'Automation' });
        expect(byTag.items.length).toBeGreaterThan(0);
        expect(byTag.items.every((hit) => hit.document.tags.includes('automation'))).toBe(true);
      });

      test('pages through every hit once, in ranked order', async () => {
        const query = { text: 'events rotation release report' };
        const whole = await search(query);
        const { items, total } = await allPages((page) => search(query, page), 2);
        expect(uris(items)).toEqual(uris(whole.items));
        expect(total).toBe(whole.total);
      });

      test('no match is an empty page, not an error', async () => {
        expect(await search({ text: 'kubernetes' })).toEqual({ items: [], total: 0 });
      });

      test('a query with nothing searchable is an EmptyQueryError', async () => {
        await expect(search({ text: '!!!' })).rejects.toThrow(EmptyQueryError);
      });

      test('a cursor is rejected for another query, and garbage is rejected', async () => {
        const first = await search({ text: 'events rotation release' }, { limit: 1 });
        expect(first.nextCursor).toBeTruthy();
        await expect(search({ text: 'something else' }, { cursor: first.nextCursor, limit: 1 })).rejects.toThrow(InvalidCursorError);
        await expect(search({ text: 'events' }, { cursor: 'garbage', limit: 1 })).rejects.toThrow(InvalidCursorError);
      });
    });
  });
}
