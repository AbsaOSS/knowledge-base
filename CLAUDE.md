# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Build-time aggregator that downloads pre-built static doc sites from GitHub Release artifacts, wraps them in a persistent branded masthead, and produces a single static deployment. Served by nginx in Docker. Can also run as a web-fragment inside an Angular SSR gateway.

## Commands

```bash
# Install
npm install                          # Node >= 24 required

# Build (needs GITHUB_TOKEN or gh CLI auth)
npm run build                        # fetch artifacts from GitHub + build
npm run build:local                  # build from local repos (no GitHub fetch)
npm run build:headless               # headless mode for web-fragment embedding
npm run build:local:headless         # local + headless

# Dev server
npm run dev                          # Astro dev (needs artifacts in apps/ already)
npm run dev:fetch                    # fetch artifacts then start dev

# Preview
npm run preview                      # preview built output
npm run preview:embedded             # headless preview (no compression, for web-fragments)

# Test (Playwright E2E — self-contained; auto-starts both servers)
npm test                             # headless
npm run test:ui                      # Playwright UI
npm run test:headed                  # visible browser
npm run test:debug                   # debug mode

# Docker
docker build -t knowledge-base .
docker run -p 8080:8080 knowledge-base
```

## Build Pipeline

```
apps.json (registry)
  → [1] Fetch Release artifacts OR build local repos → apps/{slug}/
  → [2] Copy non-HTML assets → public/{slug}/ (Astro serves as static)
  → [3] astro build: [...path].astro enumerates all HTML via getStaticPaths
         → transformSubAppHtml() rewrites URLs + splits the document,
           which Base.astro then re-hosts (masthead + head/body)
  → dist/
```

Orchestrator: `scripts/build-vite.js`. Flags: `--local`, `--headless`, `--path-prefix=`.

## Two Build Configs

- **astro.config.mjs** — Astro SSG config, base `/knowledge-base`, used by `astro build`/`astro dev`
- **vite.config.js** — standalone Vite config with custom `marketplacePlugin` from `plugins/marketplace.js`, base `/`, used for the non-Astro build path

## Architecture

### Core Data Flow

`apps.json` → `scripts/fetch-apps.js` downloads `dist.tar.gz` per app → `apps/{slug}/` → Astro's `src/pages/[...path].astro` catchall uses `getStaticPaths()` from `src/utils/apps.js` to enumerate every HTML file → `src/utils/transform.js` rewrites URLs and splits the document → `Base.astro` re-hosts the parts → static output in `dist/`.

### Key Source Files

- `src/pages/[...path].astro` — Catchall route, renders every sub-app page through `Base.astro`
- `src/pages/index.astro` — Landing catalog page
- `src/utils/apps.js` — `getAppPages()` enumerates sub-app HTML (manifest-driven or filesystem crawl)
- `src/utils/transform.js` — `transformSubAppHtml()`: URL rewriting, document splitting (head/body/title/body-class), headless transforms
- `src/layouts/Base.astro` — The one document shell: head, fonts, marketplace CSS, theme script, `<ClientRouter />`
- `src/components/Chrome.astro` — 56px fixed top bar (standalone mode only)
- `src/components/Masthead.astro` — Persistent Knowledge base header + Library/current-app sub-nav (all pages, both modes)
- `src/templates/chrome.js` — Inline theme script + shadow-DOM compat styles injected by the layout
- `src/utils/single-page.js` — Bundle manifest reading/validation + registry expansion, shared by both fetch paths and by Astro
- `scripts/build-vite.js` — Build orchestrator (3-step pipeline)
- `scripts/fetch-apps.js` — GitHub Release artifact downloader
- `actions/publish-docs/` — Reusable GitHub Action that turns a repo's markdown into a single-page bundle

### Three Onboarding Types

An `apps.json` entry is one of:

- **default (packaged)** — a repo publishes a headless static site as `dist.tar.gz` plus `marketplace.json`. Every HTML file becomes a route.
- **`type: "iframe"`** — no artifact; a single route renders a full-viewport `<iframe>` for an external URL. Explicit stopgap (issue #10).
- **`type: "single-page"`** — one release artifact holding *many* docs, published by `actions/publish-docs` from plain markdown. The entry carries **no per-doc metadata** (`{ "repo": …, "type": "single-page", "version": "latest" }`); the build reads the artifact's `bundle.json` and **expands** the entry into one app per doc, extracting each into `apps/{slug}/`. The expansion is recorded in `apps/.single-page.json` and spliced back into the registry by `loadRegistry()` so Astro sees the same registry the build did. Slugs must be globally unique — `resolveRegistry()` fails the build otherwise. Rendering: masthead, no sidebar, content in a centred `main.mp-single-page` reading column. See issue #35 and `contract/SINGLE_PAGE.md`.

### Two Modes

Both modes render the same document: the masthead (`Masthead.astro`) — branding plus the Library / current-app sub-navigation — on every page, and nothing else chrome-like. There is no fixed top bar and no app switcher; the masthead is the navigation.

**Non-headless** (standalone): Plain marketplace pages. Navigation is Astro's `<ClientRouter />` (view transitions).

**Headless** (web-fragment): Marks `data-mp-headless="true"` and injects shadow DOM compat styles. Designed for embedding in a web-fragments gateway.

### Light Only

The marketplace has no dark mode: no theme toggle, no persisted theme, no `dark` class, no dark palette. `transformSubAppHtml()` strips any sub-app theme bootstrap and `dark` body class so an embedding host's theme cannot bleed into the fragment.

### URL Rewriting

`transform.js` rewrites all relative and root-relative URLs to absolute `/{prefix}/{slug}/...` paths. Runs before the document is split so nothing is double-rewritten. Removes `<base>` tags.

## Contract for Doc Apps

Apps registered in `apps.json` must comply with:
- `contract/schema.json` — JSON Schema for `marketplace.json` manifest (packaged apps)
- `contract/HEADLESS_RULES.md` — Structural requirements (headless HTML, relative paths, `data-mp-headless` attribute)
- `contract/STYLE_GUIDE.md` — Design tokens and typography (light only — the marketplace has no dark mode)
- `contract/SINGLE_PAGE.md` — `bundle.json` format + the copy-paste onboarding workflow for single-page docs

## Testing

Self-contained Playwright E2E — `npm test` auto-starts everything (no external gateway):

1. **:3000 fragment** — `scripts/setup-test-apps.mjs` writes a hermetic `apps.json` that
   registers the local `../knowledge-base-docs-example` prebuilt `dist.tar.gz` twice
   (slugs `user-guide` + `guide-mirror`, for cross-app nav). `build:headless` builds it;
   `tests/fragment-server.mjs` serves `dist/` mirroring the production **nginx** rewrites
   (`/__wf/knowledge-base/*` → `/knowledge-base/*`). NB: `astro preview` is NOT used — its
   Vite `configurePreviewServer` rewrite hook does not run for static output, so the
   marketplace CSS 404s; the nginx-mirror server is the faithful fragment endpoint.
2. **:4201 host** — `tests/host/server.mjs`, a minimal Express "wrapping web-fragment
   application" (`FragmentGateway` + `getNodeMiddleware`) that proxies/embeds the :3000
   fragment on a single origin via `<web-fragment fragment-id="knowledge-base">`.

Tests drive the host origin (`http://localhost:4201`). Suites (`tests/`):
- `build-integrity.spec.js` — `dist/` output: both apps enumerated, absolute URL rewriting,
  headless markup, stable `dist/style.css` (the marketplace CSS the sub-app pages reference),
  and single-page bundle expansion (`tests/fixtures/single-page-bundle/` → two apps).
- `web-fragment.spec.js` — shadow-DOM isolation (reframed `wf-html`/`wf-body`; chrome must
  not leak in), routing + smooth no-reload SPA transitions, cross-app navigation, asset
  loading (no host-origin 404s), and the documented history limitation (fragment routing is
  internal to the reframed `wf:<id>` iframe and is not mirrored to top-window history).
- `support/fragment.js` — shadow-DOM traversal + reframed-body wait/query helpers.

Two build-pipeline pieces support this: `apps.json` entries may carry a `prebuilt` path
(tarball or dist dir) consumed by `scripts/build-vite.js` (`preparePrebuilt`) for hermetic
offline builds; and the build aliases the bundled marketplace CSS to a stable `dist/style.css`.

## Environment Variables

- `GITHUB_TOKEN` — GitHub API auth for fetching Release artifacts
- `MP_HEADLESS` — `true`/`false`, controls headless mode
- `MP_PREFIX` — URL prefix (default: `knowledge-base`)
- `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE` — deployment config
