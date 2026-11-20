# Developing the MCP server

How the knowledge base MCP server is built, tested and extended. The decision record behind it is
[adr/0001-mcp-server.md](adr/0001-mcp-server.md).

The server lives in `mcp-server/`, a self-contained Python project. It shares no code with the
site: it reads what the site build publishes under `dist/` and nothing else.

## Quick start

Needs [uv](https://docs.astral.sh/uv/); uv installs the Python version in `.python-version`.

```sh
# once: a site build to index (from the repository root)
node scripts/setup-test-apps.mjs && npm run build:headless

cd mcp-server
uv sync --all-extras                               # runtime, indexer and dev tools
uv run kb-mcp index --dist ../dist --out index.sqlite
KB_MCP_INDEX=index.sqlite uv run kb-mcp serve      # http://127.0.0.1:8081/mcp
```

Explore it with `npx @modelcontextprotocol/inspector` (transport *Streamable HTTP*, URL above).

## Checks

Run from `mcp-server/`. CI's `mcp` job runs the same commands.

| Check | Command |
|---|---|
| Format | `uv run ruff format --check .` (`uv run ruff format .` to fix) |
| Lint | `uv run ruff check .` |
| Types | `uv run mypy` (strict) |
| Layering | `uv run lint-imports` |
| Tests | `uv run pytest` (fails under 90% branch coverage) |

The tests build their own small site in a temporary directory, so they do not need `dist/`.

## How it fits together

```
build time                                              run time
──────────                                              ────────
dist/_kb/pages.json ─┐
dist/**/index.html ──┴▶ kb_mcp.indexer ──▶ index.sqlite ──▶ kb_mcp (kb-mcp serve)
                                              ▲
                                  kb_mcp.index_format (the schema both sides share)
```

- **`dist/_kb/pages.json`** — the page manifest the site build writes (step 3b,
  `scripts/page-manifest.js`; schema `scripts/page-manifest.schema.json`). It lists every published
  page with its app. `indexer/manifest.py` validates it strictly: a manifest from a newer build fails
  instead of being indexed wrongly. `tests/fixtures/pages.json` is a real one, and CI indexes the
  real build too.
- **`kb_mcp.index_format`** — the SQLite schema: documents, sections, apps, an FTS5 table for ranked
  search (Porter stemming, `bm25()` with the title weighted highest) and an unstemmed one whose
  vocabulary drives compound splitting and misspelling correction.
- **`kb_mcp.indexer`** — build time only, and the only code that needs the HTML parser (the
  `indexer` extra):
  - `extract.py` turns untrusted page HTML into bounded markdown-like text with section offsets
    (Lexbor, an HTML5 parser; the knowledge base masthead, navigation, scripts and hidden content
    are dropped; offsets are code points);
  - `build.py` writes the index to a temporary file and moves it into place.

### Runtime layers

```
http.py (Starlette: /mcp, /healthz, browser page) ─▶ protocol/ (MCPServer, tools, resources)
                                                        │
                                                        ▼
                                          service.py: KnowledgeBase (facade)
                                                │                │
                                     DocumentRepository     SearchBackend     ← ports.py
                                                │                │
                                     adapters/sqlite.py: SqliteDocuments, SqliteSearch
```

- **`http.py`** — the ASGI app. The SDK's stateless, JSON-response Streamable HTTP app is mounted at
  `/mcp`, with its Host/Origin checks and a 64 KiB body cap; CORS for `KB_MCP_ALLOWED_ORIGINS`; a 405
  page for a browser that opens the endpoint; `/healthz`.
- **`protocol/`** — `server.py` builds the `MCPServer` and its instructions; `tools.py` holds the
  three tools; `resources.py` registers every document as a `kb://` resource.
- **`service.py`** — the facade, and the only thing the protocol layer calls. It owns the public
  result models (which the SDK turns into output schemas), links, bounded reads and limits. It raises
  the typed errors in `domain.py`; `tools.py` reports those as tool errors, anything else is a
  server fault.
- **`ports.py`** — what a backend implements. The ports are synchronous: the SDK runs synchronous
  tools in worker threads. Cursors are opaque and owned by the adapter.
- **`adapters/`** — `sqlite.py` serves both ports from the index file, opened read-only; `query.py`
  decides which words to search for; `cursor.py` binds a cursor to its query and the index content.
- **`compose.py`** wires adapters to the facade, **`config.py`** is the only reader of the
  environment, **`__main__.py`** is the `kb-mcp` command.

`lint-imports` enforces the arrows: nothing at run time imports `kb_mcp.indexer` or `selectolax`,
`protocol`/`http` never import an adapter, and each layer only imports the ones below it.

## Adding a search backend

A vector backend, such as AWS OpenSearch, needs:

1. **Adapters** implementing `DocumentRepository` and `SearchBackend` in `adapters/<name>.py` (or a
   package). Return whatever cursor suits the backend.
2. **Wiring**: a setting in `config.py` and a branch in `compose.py`.
3. **The contract suite**: add a factory to `BACKENDS` in `tests/test_backend_contract.py`. It checks
   canonical order and complete paging, filters, cursors that refuse another query, filter or
   deployment, typed errors and deterministic best-first results. It pins no ranking.
4. **Ingestion**, if the backend needs loading: a build-time step under `kb_mcp/indexer/`. The
   server never writes to a backend.

Nothing in `protocol/` or `http.py` changes.

## Dependencies

- The MCP SDK is pinned to an exact version: it is young, and the protocol tests are the gate for
  every bump. Dependabot opens SDK bumps on their own.
- `uv.lock` is the source of truth. Images install from a hash-pinned export of it
  (`uv export --frozen`), which carries no registry URLs, so the same lockfile installs from PyPI or
  from an internal mirror.
