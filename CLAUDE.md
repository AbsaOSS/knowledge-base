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
npm run preview                      # serve the built dist/ (astro preview, :4321)

# Test (Playwright E2E — self-contained; auto-starts its own servers)
npm test                             # embedded web-fragment harness
npx playwright test --config=playwright.config.ci.js   # standalone fragment server
npm run test:container               # real nginx image (needs Docker)
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
  → [1b] Hoist inline <script> bodies → apps/{slug}/_kb-inline/*.js
         (keeps script-src 'self' viable for already-published bundles)
  → [2] Copy non-HTML assets → public/{slug}/ (Astro serves as static)
  → [3] astro build: [...path].astro enumerates all HTML via getStaticPaths
         → transformSubAppHtml() rewrites URLs + splits the document,
           which Base.astro then re-hosts (masthead + head/body)
  → dist/
```

Orchestrator: `scripts/build-vite.js`. Flags: `--local`, `--headless`.

## Build Config

**astro.config.mjs** is the only build config — base `/knowledge-base`, used by `astro build`/`astro dev`. There is no non-Astro build path.

`src/utils/config.js` holds what both the config and the pages need: `PATH_PREFIX`/`BASE_PATH` and `isHeadlessBuild()`. Import them; do not re-spell either one inline.

## Architecture

### Core Data Flow

`apps.json` → `scripts/fetch-apps.js` downloads `dist.tar.gz` per app → `apps/{slug}/` → Astro's `src/pages/[...path].astro` catchall uses `getStaticPaths()` from `src/utils/apps.js` to enumerate every HTML file → `src/utils/transform.js` rewrites URLs and splits the document → `Base.astro` re-hosts the parts → static output in `dist/`.

### Key Source Files

- `src/pages/[...path].astro` — Catchall route, renders every sub-app page through `Base.astro`
- `src/pages/index.astro` — Landing catalog page
- `src/utils/apps.js` — `getAppPages()` enumerates sub-app HTML (manifest-driven or filesystem crawl)
- `src/utils/transform.js` — `transformSubAppHtml()`: URL rewriting, document splitting (head/body/title/body-class), headless transforms
- `src/layouts/Base.astro` — The one document shell: head, fonts, marketplace CSS, `<ClientRouter />`, shadow-DOM compat styles
- `src/components/Masthead.astro` — Persistent Knowledge base header + Library/current-app sub-nav (all pages, both modes)
- `src/components/AppCard.astro`, `src/components/AppIcon.astro` — Catalog card and its icon
- `src/templates/shadow-compat.js` — Shadow-DOM design-token styles, injected into the body by the layout
- `src/utils/config.js` — `PATH_PREFIX`/`BASE_PATH` and `isHeadlessBuild()` — the build-wide constants
- `src/utils/single-page.js` — Bundle manifest reading/validation + registry expansion, shared by both fetch paths and by Astro
- `scripts/build-vite.js` — Build orchestrator (4 steps: prepare, hoist, copy assets, astro build)
- `scripts/fetch-apps.js` — GitHub Release artifact downloader
- `scripts/artifacts.js` — Safe tarball extraction + tree copy, shared by both fetch paths. Validates archive members (no traversal, no absolute paths, no symlinks) before anything is written, and replaces the old `cp -r`/`tar` shell-outs so the build runs on Windows
- `scripts/hoist-inline-scripts.js` — Moves inline `<script>` bodies in sub-app HTML into files before the Astro build, so the deployment can serve `script-src 'self'`. Needed because bundles published before the action stopped emitting an inline mermaid bootstrap still contain one. A sub-app's dark-mode bootstrap is deleted here rather than hoisted — light only, and hoisting would put it beyond the reach of `transform.js`
- `actions/publish-single-page-docs/` — Reusable GitHub Action that turns a repo's markdown into a single-page bundle

### Three Onboarding Types

An `apps.json` entry is one of:

- **default (packaged)** — a repo publishes a headless static site as `dist.tar.gz` plus `marketplace.json`. Every HTML file becomes a route.
- **`type: "iframe"`** — no artifact; a single route renders a full-viewport `<iframe>` for an external URL. Explicit stopgap (issue #10).
- **`type: "single-page"`** — one release artifact holding *many* docs, published by `actions/publish-single-page-docs` from plain markdown. The entry carries **no per-doc metadata** (`{ "repo": …, "type": "single-page", "version": "latest" }`); the build reads the artifact's `bundle.json` and **expands** the entry into one app per doc, extracting each into `apps/{slug}/`. The expansion is recorded in `apps/.single-page.json` and spliced back into the registry by `loadRegistry()` so Astro sees the same registry the build did. Slugs must be globally unique — `resolveRegistry()` fails the build otherwise. Rendering: masthead, no sidebar, content in a centred `main.mp-single-page` reading column. See issue #35 and `contract/SINGLE_PAGE.md`.

### Two Modes

Both modes render the same document: the masthead (`Masthead.astro`) — branding plus the Library / current-app sub-navigation — on every page, and nothing else chrome-like. There is no fixed top bar and no app switcher; the masthead is the navigation.

**Non-headless** (standalone): Plain marketplace pages. Navigation is Astro's `<ClientRouter />` (view transitions).

**Headless** (web-fragment): Marks `data-mp-headless="true"` on `<html>`, for embedding in a web-fragments gateway. That attribute is the only difference in the output — the shadow-DOM compat styles are emitted in both modes.

Resolution order: a per-app `"headless"` in `apps.json` wins; otherwise `isHeadlessBuild()`.

### Light Only

The marketplace has no dark mode: no theme toggle, no persisted theme, no `dark` class, no dark palette. A sub-app's own theme bootstrap is removed twice over — `hoist-inline-scripts.js` deletes it while it is still inline, and `transformSubAppHtml()` strips any that reaches Astro, along with a `dark` body class — so an embedding host's theme cannot bleed into the fragment.

Known gap: inline `on*` handlers in sub-app HTML are not stripped (#67). They are inert under the CSP but not under `astro dev`.

### URL Rewriting

`transform.js` parses the document with **parse5** and rewrites every URL-bearing attribute to an absolute `/{prefix}/{slug}/…` path: `href`/`src`/`action`/`formaction`/`poster`, `object[data]`, `srcset`/`imagesrcset`, `url()` in inline `style=` and `<style>` blocks, and URL-bearing `<meta>` content. `<base>` tags are removed. Because it walks a parsed tree, markup quoted inside prose or comments is left alone.

Root-relative `url()` inside a sub-app's **copied CSS files** is a separate rewrite, in `copyAssets()` (`scripts/build-vite.js`), targeting the same absolute path.

## Contract for Doc Apps

Apps registered in `apps.json` must comply with:
- `contract/schema.json` — JSON Schema for `marketplace.json` manifest (packaged apps)
- `contract/HEADLESS_RULES.md` — Structural requirements (headless HTML, relative paths, `data-mp-headless` attribute)
- `contract/STYLE_GUIDE.md` — Design tokens and typography (light only — the marketplace has no dark mode)
- `contract/SINGLE_PAGE.md` — `bundle.json` format + the copy-paste onboarding workflow for single-page docs

## Testing

Self-contained Playwright E2E — `npm test` auto-starts everything (no external gateway):

1. **:3000 fragment** — `scripts/setup-test-apps.mjs` writes a hermetic `apps.json` that
   registers the vendored `tests/fixtures/docs-example.dist.tar.gz` twice
   (slugs `user-guide` + `guide-mirror`, for cross-app nav), an iframe entry pinned
   `"headless": false`, and the generated single-page bundle fixture. `build:headless` builds it;
   `tests/fragment-server.mjs` serves `dist/` mirroring the production **nginx** rewrites
   (`/__wf/knowledge-base/*` → `/knowledge-base/*`). NB: `astro preview` is NOT used — its
   Vite `configurePreviewServer` rewrite hook does not run for static output, so the
   marketplace CSS 404s; the nginx-mirror server is the faithful fragment endpoint.
2. **:4201 host** — `tests/host/server.mjs`, a minimal Express "wrapping web-fragment
   application" (`FragmentGateway` + `getNodeMiddleware`) that proxies/embeds the :3000
   fragment on a single origin via `<web-fragment fragment-id="knowledge-base">`.

Tests drive the host origin (`http://localhost:4201`). Suites (`tests/`), all four
commands listed in `AGENTS.md`:
- `build-integrity.spec.js` — `dist/` output: both apps enumerated, absolute URL rewriting,
  headless markup and the per-app `"headless"` override, the content-hashed marketplace
  stylesheet plus its stable `dist/style.css` alias, no inline script anywhere, and
  single-page bundle expansion (`tests/fixtures/single-page-bundle/` → two apps).
- `transform.spec.js` — unit tests for `transformSubAppHtml()`: the malformed and
  hostile documents no fixture app happens to ship.
- `web-fragment.spec.js` — shadow-DOM isolation (reframed `wf-html`/`wf-body`; host chrome must
  not leak in), routing + smooth no-reload SPA transitions, cross-app navigation, asset
  loading (no host-origin 404s), and the documented history limitation (fragment routing is
  internal to the reframed `wf:<id>` iframe and is not mirrored to top-window history).
- `artifact-safety.spec.js` — tarball extraction guards (traversal, absolute paths, symlinks).
- `nginx-config.spec.js` — static assertions on `nginx.conf`/`nginx.headers.conf`, including
  that the CSP the Express mirror serves is byte-identical to nginx's.
- `standalone.spec.js` — the `:3000` fragment server directly (`playwright.config.ci.js`).
- `container.spec.js` — the real nginx image (`playwright.config.docker.js`, needs Docker).
- `support/fragment.js` — shadow-DOM traversal + reframed-body wait/query helpers.

Two build-pipeline pieces support this: `apps.json` entries may carry a `prebuilt` path
(tarball or dist dir) consumed by `scripts/build-vite.js` (`preparePrebuilt`) for hermetic
offline builds; and the build copies the marketplace stylesheet — identified as the local
stylesheet the landing page loads — to a stable `dist/style.css` alias. Pages themselves
reference the content-hashed bundle Astro injects, so nothing depends on that filename.

An entry may also carry `"optional": true`: the build then skips it with a warning when its
`prebuilt`/`localPath` artifact is missing, instead of failing. That is how the sibling
`knowledge-base-example-single-page` repo (a mock docs repo whose `dist.tar.gz` comes from
the real action — `npm run build:local && npm run preview` to view it) can stay registered
in the committed `apps.json` without breaking CI, which only has this repo.

## Environment Variables

- `GITHUB_TOKEN` — GitHub API auth for fetching Release artifacts
- `MP_HEADLESS` — `true` produces web-fragment output; **anything else, including unset, means standalone**. `scripts/build-vite.js` always exports an explicit value, so the default only applies when `astro build`/`astro dev` runs directly. Read it through `isHeadlessBuild()`, never inline. A per-app `"headless"` in `apps.json` overrides it in either direction.
- `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE` — deployment config
- `KB_EXAMPLE_ARTIFACT` — overrides the packaged artifact `scripts/setup-test-apps.mjs` registers
- `KB_CONTAINER_PORT`, `KB_SKIP_BUILD` — container-suite harness (`tests/container/serve.mjs`); CI sets `KB_SKIP_BUILD` because its image job already built the image

The URL prefix is **not** an environment variable: it is the `PATH_PREFIX` constant in `src/utils/config.js`. `nginx.conf`, `tests/fragment-server.mjs` and the gateway's route patterns hard-code the same string, so changing it means changing all of them together.
