// The protocol cases the golden suite pins and the bundle suite replays.
import { PROTOCOL_VERSION } from './mcp.js';

// Every case the refactor must reproduce. [label, method, params]
export const CASES = [
  ['initialize', 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'golden', version: '1' } }],
  ['tools/list', 'tools/list', {}],
  ['search: exact phrase', 'tools/call', { name: 'search_documents', arguments: { query: 'release process' } }],
  ['search: natural language', 'tools/call', { name: 'search_documents', arguments: { query: 'How do I rotate passwords for service accounts?' } }],
  ['search: camel case compound', 'tools/call', { name: 'search_documents', arguments: { query: "What's EventBus?" } }],
  ['search: split compound', 'tools/call', { name: 'search_documents', arguments: { query: 'eventbus consumers' } }],
  ['search: misspelling', 'tools/call', { name: 'search_documents', arguments: { query: 'create aquasec suppresion report' } }],
  ['search: stop words only', 'tools/call', { name: 'search_documents', arguments: { query: 'how do I' } }],
  ['search: no searchable terms', 'tools/call', { name: 'search_documents', arguments: { query: '!!!' } }],
  ['search: no match', 'tools/call', { name: 'search_documents', arguments: { query: 'kubernetes' } }],
  ['search: app filter', 'tools/call', { name: 'search_documents', arguments: { query: 'events schema', app: 'eventbus' } }],
  ['search: tag filter', 'tools/call', { name: 'search_documents', arguments: { query: 'release', tag: 'AUTOMATION' } }],
  ['search: unknown app', 'tools/call', { name: 'search_documents', arguments: { query: 'events', app: 'nope' } }],
  ['search: page 1', 'tools/call', { name: 'search_documents', arguments: { query: 'events rotation release', limit: 1 } }],
  ['search: deep section excerpt', 'tools/call', { name: 'search_documents', arguments: { query: 'on-call engineers' } }],
  ['search: invalid cursor', 'tools/call', { name: 'search_documents', arguments: { query: 'events', cursor: 'bogus' } }],
  ['search: invalid input', 'tools/call', { name: 'search_documents', arguments: { query: 'events', limit: 99, extra: true } }],
  ['list: all', 'tools/call', { name: 'list_documents', arguments: {} }],
  ['list: app', 'tools/call', { name: 'list_documents', arguments: { app: 'service-accounts' } }],
  ['list: tag', 'tools/call', { name: 'list_documents', arguments: { tag: 'Events' } }],
  ['list: title', 'tools/call', { name: 'list_documents', arguments: { title: 'RELEASE' } }],
  ['list: page 1', 'tools/call', { name: 'list_documents', arguments: { limit: 2 } }],
  ['read: default', 'tools/call', { name: 'read_document', arguments: { uri: 'kb://eventbus' } }],
  ['read: surrogate boundary', 'tools/call', { name: 'read_document', arguments: { uri: 'kb://service-accounts/ops/handbook' } }],
  ['read: offset slice', 'tools/call', { name: 'read_document', arguments: { uri: 'kb://service-accounts/ops/handbook', offset: 59000, maxChars: 1000 } }],
  ['read: unknown uri', 'tools/call', { name: 'read_document', arguments: { uri: 'kb://missing/doc' } }],
  ['read: invalid uri', 'tools/call', { name: 'read_document', arguments: { uri: 'https://example.com' } }],
  ['resources/templates/list', 'resources/templates/list', {}],
  ['resources/list: page 1', 'resources/list', {}],
  ['resources/list: invalid cursor', 'resources/list', { cursor: 'bogus' }],
  ['resources/read: short', 'resources/read', { uri: 'kb://eventbus/schemas' }],
  ['resources/read: long', 'resources/read', { uri: 'kb://service-accounts/ops/handbook' }],
  ['resources/read: unknown', 'resources/read', { uri: 'kb://missing' }],
  ['unknown tool', 'tools/call', { name: 'delete_everything', arguments: {} }],
  ['unknown method', 'prompts/list', {}],
];

/** Follow-up page requests: [label, of case, field holding the cursor, how to rebuild the params]. */
export const FOLLOW_UPS = [
  ['search: page 2', 'search: page 1', (params, cursor) => ({ ...params, arguments: { ...params.arguments, cursor } })],
  ['list: page 2', 'list: page 1', (params, cursor) => ({ ...params, arguments: { ...params.arguments, cursor } })],
  ['resources/list: page 2', 'resources/list: page 1', (params, cursor) => ({ ...params, cursor })],
];

/** Run every case (and each follow-up whose first page returned a cursor) against `service`. */
export async function record(service) {
  const transcript = {};
  for (const [label, method, params] of CASES) {
    const { status, body } = await service.rpc(method, params);
    transcript[label] = { status, body };
  }
  for (const [label, of, next] of FOLLOW_UPS) {
    const [, method, params] = CASES.find(([name]) => name === of);
    const result = transcript[of].body.result;
    const cursor = result.structuredContent?.nextCursor ?? result.nextCursor;
    if (!cursor) continue;
    const { status, body } = await service.rpc(method, next(params, cursor));
    transcript[label] = { status, body };
  }
  return transcript;
}
