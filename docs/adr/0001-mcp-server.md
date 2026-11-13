# ADR 0001: The MCP server is a standalone Python service

- **Status:** Accepted
- **Date:** 2026-11-13
- **Scope:** the MCP endpoint at `/knowledge-base/mcp` (issue #117): the search index it serves,
  the server, how it is built, tested and deployed. The Astro site is out of scope except where it
  hands data to the server.

## Context

The knowledge base publishes many teams' documentation as one static site. AI agents should be able
to discover, search and read that documentation through the Model Context Protocol (MCP), without
authentication, read-only.

The facts the design has to respect:

- **The content is static and known at build time.** It changes only when the site is rebuilt. The
  server never writes, and the corpus is small (hundreds to low thousands of pages).
- **The input is untrusted third-party HTML.** It must be reduced to bounded plain text before an
  agent sees it, and treated as possible prompt injection afterwards.
- **The site is built by Node (Astro) and served by nginx** in a container that a private deployment
  repository runs (`contract/DEPLOYMENT.md`). Deployment repos may sit in private networks where
  every package comes from an internal mirror.
- **The team's main language is Python.** Whoever maintains the server next will most likely be a
  Python developer, not a TypeScript one.
- **MCP itself moved.** The 2026-07-28 revision made the core stateless (no `initialize`
  handshake, no `Mcp-Session-Id`), so a read-only server is a plain request/response HTTP service.
- **A vector backend (for example AWS OpenSearch) is a likely later step,** so the search engine
  must be replaceable without touching the protocol layer.

## Decision drivers

1. Maintainability by the team that owns it: one language, idiomatic tools, little custom code.
2. Protocol conformance tracked by an official, actively maintained SDK, not by us.
3. A clean boundary with the Node build: no Node at server build or run time, no Python in the
   Astro build.
4. Security of an unauthenticated public endpoint: bounded input, bounded output, untrusted content.
5. Deployment that fits the existing contract: same release, same version, private-mirror friendly.
6. Testability in seconds, without a browser.

## Decision

### 1. Language, SDK and runtime

- **Python 3.14** as the floor: the oldest version still receiving bug fixes when the server
  ships. `requires-python` names it, the image runs it and CI tests it.
- **The official `mcp` SDK, v2** (`MCPServer`), pinned to an exact version. It is the Tier 1 SDK,
  serves the 2026-07-28 revision and every earlier one from one server, and brings its own
  Starlette/uvicorn HTTP stack, pydantic schemas and transport security.
- **Stateless Streamable HTTP with JSON responses** (`streamable_http_app(stateless_http=True,
  json_response=True)`): no sessions, no SSE, any instance can answer any request.
- **uvicorn** as the ASGI server, behind nginx, listening on loopback/task-local networking only.

### 2. Repository layout: a self-contained Python project beside the site

```
knowledge-base/
├─ package.json, src/, scripts/ …       # the Astro site (unchanged, Node)
└─ mcp-server/                          # the MCP server (Python, nothing else)
   ├─ pyproject.toml                    # uv_build backend, dependency groups, tool config
   ├─ uv.lock
   ├─ Dockerfile                        # its own image
   ├─ src/kb_mcp/
   │  ├─ config.py                      # pydantic-settings; the only reader of env (KB_MCP_*)
   │  ├─ domain.py                      # documents, apps, pages, typed errors
   │  ├─ ports.py                       # DocumentRepository, SearchBackend (typing.Protocol)
   │  ├─ service.py                     # KnowledgeBase facade: result models, links, bounded reads
   │  ├─ index_format.py                # the SQLite schema, shared by indexer and adapter
   │  ├─ adapters/                      # sqlite.py (both ports), query.py, cursor.py
   │  ├─ protocol/                      # server.py (MCPServer), tools.py, resources.py
   │  ├─ http.py                        # Starlette app: /mcp mount, /healthz, browser page
   │  ├─ compose.py                     # wires adapters to the facade
   │  ├─ indexer/                       # build time only: page manifest, HTML → text, index writer
   │  └─ __main__.py                    # `kb-mcp serve | index`, argparse
   └─ tests/                            # pytest
```

- The directory is `mcp-server/` and the package `kb_mcp`, never `mcp`: a top-level `mcp` would sit
  next to the SDK's own `mcp` package on `sys.path` and invite shadowing.
- **Not a uv workspace at the root.** There is one Python project; a workspace adds a root
  `pyproject.toml` and a shared lock for nothing. Node and Python each keep their own manifest and
  lockfile, and neither tool reaches into the other's directory.
- `src/` layout, so tests run against the installed package, not the working tree.
- The indexer's extra dependency (the HTML parser) is the optional `indexer` extra; the runtime
  image installs without it.
- An **import-linter** contract forbids `kb_mcp` runtime modules from importing `kb_mcp.indexer`,
  and `protocol`/`http` from importing an adapter directly. The layering is enforced, not just drawn.

### 3. The boundary with the site: a page manifest

The Python indexer never re-implements the registry or page enumeration. The Astro build writes
one more file, `dist/_kb/pages.json`: every page it rendered with its app slug, route, source file
under `dist/`, manifest title and section, plus each app's name, description, tags, kind, external
URL and source version. That file and the HTML under `dist/` are the whole interface.

- The Node side owns producing it; the Python side owns validating it (a pydantic model that
  rejects unknown versions).
- A fixture copy of `pages.json` from the hermetic test build is checked into `mcp-server/tests/`,
  and a test on the Node side fails if a fresh build's output no longer validates against the same
  JSON Schema. The seam is a versioned file, not shared code.

### 4. The index: SQLite with FTS5, built once at image build time

`kb-mcp index --dist dist --out index.sqlite` reads the page manifest, extracts every page and
writes a single SQLite database:

- `apps`, `documents` (uri, route, title, description, tags, text, sha256, size, source version) and
  `sections` (heading, anchor, level, start, end) tables;
- an FTS5 virtual table over title, description, app name, tags and text with the `porter
  unicode61` tokenizer, ranked by FTS5's built-in `bm25()` with column weights (title highest);
- a `meta` table: schema version, content hash, generator, indexed-at.

The server opens it **read-only and immutable** (`file:…?mode=ro&immutable=1`), one connection
shared by the worker threads (SQLite serialises it; nothing writes). Query expansion that FTS5 does
not do natively — splitting a compound word ("eventbus" → "event bus") and tolerating a
misspelling — is a small step over the vocabulary of a second, unstemmed FTS5 table (read through
`fts5vocab`), with `difflib` choosing the closest spellings.

**HTML extraction** uses **selectolax** (Lexbor), an HTML5-conformant parser: pages are parsed the
way browsers parse them. The extractor drops scripts, styles, navigation, hidden and `aria-hidden`
nodes, keeps headings, lists, tables and code blocks as markdown-like text, strips control and
bidi-override characters, normalises to NFC and caps each document's length. Text offsets are
Unicode code points (Python `str` indices), and that is the unit `read_document` documents.

### 5. The server

- **Tools** (all annotated read-only): `search_documents`, `list_documents`, `read_document`.
  Inputs are annotated parameters and outputs pydantic models, so the SDK publishes input and
  output schemas and returns structured content. **Resources:** every page as `kb://<app>/<path>`,
  registered once at startup (the index never changes while the process runs). The SDK does not
  paginate `resources/list`; `list_documents` is the paginated way to browse.
- **Server instructions** tell the agent the flow (search → read → cite the URL) and that document
  text is reference data, never instructions. App names and descriptions inside them are flattened
  and capped.
- **The facade (`service.py`) is the only thing the protocol layer calls.** It maps backend results
  to public shapes, builds absolute links from `KB_MCP_PUBLIC_ORIGIN`, bounds every read and raises
  typed errors; tools map errors by type, never by message.
- **Ports:** `DocumentRepository` (get, list, apps) and `SearchBackend` (search), synchronous —
  the SDK runs synchronous tools in worker threads — with cursors opaque and owned by the adapter. A new backend is a new `adapters/<name>/` package, one
  branch in the composition root, and a pass of the shared backend contract test suite.
- **Cursors** carry a fingerprint of the content hash and query, so a cursor from
  another query or another deployment is rejected.

### 6. Security: limits where they are cheapest to keep correct

| Concern | Owner | Mechanism |
|---|---|---|
| Per-client and global rate limit | nginx | `limit_req_zone` on the real client address (`real_ip` from private-range hops) |
| CORS | server | Starlette's CORS middleware for `KB_MCP_ALLOWED_ORIGINS`; nginx adds security headers but no CORS of its own on this route |
| Body size | nginx and SDK | `client_max_body_size 64k`; the SDK's `max_request_body_size` as a second line |
| Request timeout | nginx | `proxy_read_timeout`; every tool is a local, bounded SQLite query |
| Concurrency | uvicorn | `--limit-concurrency` answers 503 beyond the cap |
| Origin / DNS rebinding | SDK | `TransportSecuritySettings`: Host must be the loopback upstream, `Origin` must be in `KB_MCP_ALLOWED_ORIGINS`; requests without `Origin` (agents) pass |
| Input bounds | pydantic | field constraints: query length, limits, offsets, URI pattern |
| Untrusted content | indexer and instructions | extraction at build time; the server never parses HTML |
| Logging | server | status, method, duration; never queries or document text |

Generic HTTP protections live in the proxy that already exists, protocol protections in the SDK,
and only domain rules in our code. There is no authentication: the data is public and every tool is
read-only.

### 7. Build, image and deployment: a second image, a sidecar in the same task

- **`mcp-server/Dockerfile`** is multi-stage on a digest-pinned `python:3.14-slim`:
  1. *requirements* — `uv export --frozen` turns `uv.lock` into hash-pinned requirements;
  2. *index* — those requirements plus the `indexer` extra, `COPY dist/`, run `kb-mcp index`;
  3. *runtime* — the requirements without the extra, `index.sqlite`, non-root user, read-only
     filesystem friendly, `HEALTHCHECK` on `/healthz`, `CMD ["kb-mcp", "serve"]`.

  The image therefore contains exactly the index built from the same `dist/` as the site image.
- **The site image stays nginx-only.** It proxies `/knowledge-base/mcp` (`POST`, the `OPTIONS`
  preflight and the browser `GET`) to `127.0.0.1:8081`, the MCP container in the same task.
- **`build-image.yml` builds and pushes both images from one `dist/`, with the same tags.** One
  run, one version, never a site from one build and an index from another. The MCP image is opt-in
  (`mcp-image-name`), so an existing deployment does not start pushing to a repository it never
  created.
- **The web-fragments gateway is bypassed for this path.** Its Node middleware cannot forward a
  request body (web-fragments 0.8.2), so the load balancer or the host application routes
  `/knowledge-base/mcp` to the task directly; the site keeps going through the gateway.
- **Deployment:** both containers in **one task** (ECS task definition, or Kubernetes pod): nginx
  essential, the MCP container essential, nginx `dependsOn` the MCP container `HEALTHY`, shared
  task network so the upstream is loopback. Scaling the task scales both, which is right: the
  index is small, read-only and in each task.
- **Private networks:** `build-image.yml` gains a `python-index` input and
  `python-index-username` / `python-index-token` secrets, composed into one URL and passed to the
  image build as a BuildKit secret that becomes `UV_DEFAULT_INDEX`, mirroring `npm-registry`. `uv.lock`
  records PyPI's URL, and `uv sync --locked` refuses another index; the hash-pinned export carries
  no URL, and the hashes still verify whatever mirror serves the files.

### 8. Tooling and quality gates

| Purpose | Tool |
|---|---|
| Environment, lock, Python install | uv |
| Lint and format | ruff (`ruff check`, `ruff format --check`) |
| Types | mypy `--strict` (pydantic plugin) |
| Layering | import-linter |
| Tests | pytest with anyio's plugin; 90% branch coverage gate |
| Updates | Dependabot `uv` and `docker` ecosystems for `mcp-server/` |
| Images | Trivy on both images (existing job) |

A CI job `mcp` runs `uv sync --locked`, ruff, mypy, import-linter and pytest, then indexes the
real fixture build.

**Test pyramid:**

- unit: extraction (hostile and malformed HTML), query expansion, cursors, the facade;
- backend contract suite, parametrised over every adapter;
- protocol tests in process: the SDK's own client against the ASGI app through an ASGI transport —
  tool schemas and annotations, structured results, tool errors, resources, instructions;
- HTTP tests: health, the browser page, Origin, Host, Content-Type and body-size refusals;
- container: the existing Playwright container suite starts both images and checks the nginx
  route, limits and error pages end to end.

## Considered options

### Language

| Option | Pros | Cons |
|---|---|---|
| **Python (chosen)** | The team's main language; mature SDK; stdlib SQLite with FTS5; strong typing via mypy/pydantic | A second toolchain in the repository; site and server no longer share code |
| TypeScript on Node | Same runtime as the site; could import the registry code directly | Maintained by people who mostly write Python; tempts sharing internals across the build/runtime seam |

### Python MCP framework

| Option | Pros | Cons |
|---|---|---|
| **Official `mcp` SDK v2 (chosen)** | Tier 1, tracks the spec first, fewest dependencies, includes transport security | Fewer conveniences (no proxying, composition, auth providers — none needed) |
| Standalone FastMCP 3.x | Rich middleware, composition, OpenAPI generation, deployment helpers | Larger dependency and API surface for features a read-only server does not use; a third party between us and the spec |
| FastAPI + an MCP adapter | Familiar web framework | Adapts REST semantics to MCP; another layer to keep in step with the spec |

### Search index

| Option | Pros | Cons |
|---|---|---|
| **SQLite FTS5 (chosen)** | In the standard library; one file; BM25, tokenizer, stemming and highlighting built in; schema-checked; opened read-only, nothing loaded into memory up front | Fuzzy matching and compound splitting still need a little code; FTS5 ranking is less tunable than custom scoring |
| JSON file + hand-written ranking | Full control of ranking | We own a tokenizer, stemmer, scorer and edit-distance code, and the whole corpus sits in memory |
| bm25s / rank-bm25 | Fast BM25 in Python | Adds NumPy/SciPy; still needs separate document storage and our own persistence format |
| Tantivy (tantivy-py) | A real search engine | Native dependency and on-disk format for a corpus that does not need one |
| OpenSearch / vector store now | Semantic search | Infrastructure, cost and credentials before there is evidence lexical search falls short; the ports keep this open |

### Deployment

| Option | Pros | Cons |
|---|---|---|
| **Second image, sidecar in the site's task (chosen)** | One process per container; each image has one runtime and its own CVE surface; independent health checks; lockstep versions; loopback upstream | Deployment repos must run a two-container task — a contract change |
| One image, nginx + Python under a shell supervisor | Deployment repo unchanged | Two runtimes and two CVE surfaces in one image; a home-made supervisor; one health check for two processes |
| Separate service behind the load balancer (path routing) | Independent scaling and releases | Version skew between site and index; another service, target group and gateway route to own; scaling independence not needed at this size |
| Serverless function (Lambda) | No idle cost | Cold starts, packaging the index, a second deployment model beside the container one |

### Where the HTTP limits live

| Option | Pros | Cons |
|---|---|---|
| **nginx for generic limits, SDK for protocol checks (chosen)** | Battle-tested, configured not coded; Python code shrinks to the domain | Rate limits are only exercised by the container suite, not by in-process tests |
| All limits in the Python app | Testable in process; works without nginx | A rate limiter, body reader and proxy-address logic of our own to maintain |

## Consequences

**Positive**

- The server is ordinary, idiomatic Python a team member can read end to end; most of what is
  generic (protocol, transport security, HTTP limits, ranking) is delegated to the SDK, nginx and
  SQLite.
- Protocol revisions arrive with SDK upgrades, not with our code.
- The site image goes back to nginx only; Node never ships at run time.
- The seam with the site is two files (`pages.json` and the HTML), versioned and testable on both
  sides.
- A future vector backend is an adapter plus an ingestion step; protocol and HTTP stay untouched.

**Negative**

- Two toolchains (npm and uv) and two lockfiles in one repository; CI, Dependabot and the
  private-mirror support must cover both.
- `contract/DEPLOYMENT.md` changes: deployments run two containers per task and pass a Python
  package mirror in private networks.
- Rate limiting is verified only against the real image.
- FTS5's BM25 ranks differently from any hand-tuned scorer; relevance is checked with golden
  queries, not pinned scores.

**Risks**

- The SDK v2 API is young (2.x since mid-2026); it is pinned exactly and the protocol tests are
  the upgrade gate.
- The SQLite build in the base image must have FTS5 enabled (it does in CPython's official images);
  the server checks it at startup and refuses to start without it.
