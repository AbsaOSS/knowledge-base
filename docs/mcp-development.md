# Developing the MCP server

How the knowledge base MCP server is built, tested and extended. For what it offers and how to
run it in production, see [mcp.md](mcp.md).

## Quick start

```sh
npm install
make fixture-build      # hermetic headless build; writes dist/_mcp/search-index.json
make mcp-dev            # serve from source on :8081, restart on change
make lint               # tsc --noEmit, ESLint, Prettier check
make test-mcp           # MCP suites only, in seconds
```

Every make target delegates to an npm script (`npm run mcp:dev`, `npm run lint`,
`npm run test:mcp`, …), so make is optional. On Windows, install it with
`winget install ezwinports.make` and run it from Git Bash.

## How it fits together

The server is TypeScript. Node runs the sources as-is by stripping the types, so there is no
compile step in development or tests. `mcp/tsconfig.json` therefore allows only syntax Node can
erase (no enums, namespaces or parameter properties), and relative imports spell their `.ts`
extension.

```
build time                                      run time
──────────                                      ────────
dist/ HTML ──▶ mcp/build/index-builder.ts ──▶ search-index.json ──▶ mcp/src/ (server.mjs)
                 └ extract.ts (parse5)            ▲
                                    mcp/search-index/schema.ts (the shared format)
```

- **`mcp/search-index/schema.ts`** — the search index file format and `validateSearchIndex()`.
  The only code build and runtime share.
- **`mcp/build/`** — build time only:
  - `extract.ts` turns untrusted page HTML into bounded markdown-like text;
  - `index-builder.ts` writes the search index;
  - `bundle.ts` holds the esbuild configuration.

  `scripts/build-mcp.js` calls them in build step 3b.
- **`mcp/src/`** — the runtime, bundled into `dist/_mcp/server.mjs`.

An ESLint rule keeps `mcp/src/` from importing `mcp/build/`, parse5 or the Astro utilities, so
build-time code cannot reach the bundle.

### Runtime layers

```
transport/ (HTTP guards, limits) ─▶ protocol/ (tools, resources) ─▶ KnowledgeBase (facade)
                                                                       │            │
                                                          DocumentRepository   SearchBackend   ← ports.ts
                                                                       │            │
                                                          adapters/memory/: SearchIndexRepository, LexicalSearch
```

- **`transport/`** — the stateless HTTP handler: Origin check, body cap, per-client and global
  rate limits, in-flight cap, timeout. Also the listener, with `/healthz` and browser error pages.
- **`protocol/`** — one file per tool (`tools/`), the `kb://` resources, the input and output
  schemas, and `server.ts`. It builds an MCP server per request on the official SDK v2
  `McpServer`.
- **`knowledge-base.ts`** — the facade, and the only thing the protocol layer calls. It turns
  backend results into what clients see: public document shapes, links, app names, bounded
  reads that never split a surrogate pair. It throws typed errors (`domain.ts`), which the tool
  layer maps by class, never by message.
- **`ports.ts`** — what a backend implements:
  - `DocumentRepository`: get, list, apps;
  - `SearchBackend`: search.

  Both are async. Cursors are opaque and owned by the adapter that issued them.
- **`adapters/memory/`** — today's backend, everything served from the search index file:
  - `SearchIndexRepository` keeps documents in canonical order, with a URI map;
  - `LexicalSearch` ranks by stemmed term frequency with a title boost, splits compound words
    ("eventbus" → "event bus") and matches misspellings.
- **`compose.ts`** — wires adapters to the facade. **`config.ts`** — the only code that reads
  argv or the environment. **`main.ts`** — the entry point.

## Adding a search backend

A new backend, such as a vector index in AWS OpenSearch, needs four things:

1. **Adapters.** Implement `DocumentRepository` and `SearchBackend` in `mcp/src/adapters/<name>/`.
   Return whatever cursor format suits the backend (`search_after`, a point-in-time id…); the
   facade passes it through untouched.
2. **Wiring.** Add the name to `BACKENDS` in `config.ts` and a branch in `compose.ts` that builds
   the adapters from config.
3. **Contract test.** Add a spec that calls `describeBackendContract()` from
   `tests/support/backend-contract.js` with a factory for your adapters. The suite checks:
   - canonical order and complete paging;
   - filters;
   - cursors rejected for another query or filter;
   - typed errors;
   - deterministic, best-first results.

   It does not pin a ranking, so a vector backend can pass it.
4. **Ingestion.** If the backend needs its documents loaded, add that as a build-side step under
   `mcp/build/`, next to `index-builder.ts`. The runtime never writes to a backend.

Nothing in `protocol/` or `transport/` changes.

## Tests

`npm run test:mcp` (`playwright.config.mcp.js`) runs the MCP suites alone, without a browser, over
the `dist/` a build left behind. They also run as part of `npm test`.

| Suite | Pins |
|---|---|
| `mcp-golden.spec.js` | Byte-exact responses for every protocol case over a synthetic search index, the same with a public origin, the extraction of a hostile page, and the search index the fixture build generates |
| `mcp-backend-contract.spec.js` | The memory adapters against the backend contract |
| `mcp-bundle.spec.js` | The built `server.mjs` answers every case exactly like the source, and stays within its size budget |
| `mcp-server.spec.js` | HTTP guards, CORS, rate limits, log hygiene |
| `mcp-search.spec.js`, `mcp-extract.spec.js`, `mcp-index-builder.spec.js`, `mcp-error-page.spec.js` | Ranking examples, extraction, index edge cases, browser error pages |

The golden files live in `tests/fixtures/mcp/golden/`, and the cases in
`tests/support/mcp-cases.js`. Any diff there is a regression, unless you meant to change what the
server answers. In that case, regenerate them and review the diff like code:

```sh
UPDATE_GOLDEN=1 npm run test:mcp
```

`tests/support/mcp.js` starts the runtime for tests, either in process or as the bundle in a
child process.

## The bundle

`mcp/build/bundle.ts` builds one minified, dependency-free `server.mjs` (about 410 KB, against a
450 KiB budget enforced by `make size`). Two substitutions keep it small. Both apply only to the
bundle; dev and tests run the unmodified packages, and `mcp-bundle.spec.js` proves the two
behave the same.

- **zod locales.** zod's classic API re-exports every locale as `z.locales`, and a namespace
  import keeps all of them. A resolver plugin keeps English only, which saves about 258 KB.
- **The SDK's JSON Schema validator.** The SDK's Node shim makes Ajv the default validator. The
  server uses that validator only for elicitation and `fromJsonSchema()`, and calls neither. The
  bundle aliases the shim to `src/sdk-shims.ts`, which uses the SDK's own Cloudflare Workers
  validator instead. That saves about 143 KB.

No source map ships: the server logs no stack traces.

## Framework

The server uses the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` and
`/node`), with zod 4 schemas. It was chosen over FastMCP, mcp-framework, xmcp and a hand-rolled
JSON-RPC server for three reasons:
- among well-maintained Node options it is the only one on the current protocol revision with
  stateless HTTP built in;
- its dependency tree is small and bundles cleanly;
- none of the alternatives helps with a pluggable search backend, which is this repository's
  own design anyway.
