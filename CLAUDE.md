# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Build-time aggregator that downloads pre-built static doc sites from GitHub Release artifacts, injects a persistent branded chrome (56px top nav), and produces a single static deployment. Served by nginx in Docker. Can also run as a web-fragment inside an Angular SSR gateway.

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

# Test (Playwright E2E — needs web-fragments gateway running on :4201)
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
         → transformSubAppHtml() rewrites URLs + injects chrome
  → dist/
```

Orchestrator: `scripts/build-vite.js`. Flags: `--local`, `--headless`, `--path-prefix=`.

## Two Build Configs

- **astro.config.mjs** — Astro SSG config, base `/knowledge-base`, used by `astro build`/`astro dev`
- **vite.config.js** — standalone Vite config with custom `marketplacePlugin` from `plugins/marketplace.js`, base `/`, used for the non-Astro build path

## Architecture

### Core Data Flow

`apps.json` → `scripts/fetch-apps.js` downloads `dist.tar.gz` per app → `apps/{slug}/` → Astro's `src/pages/[...path].astro` catchall uses `getStaticPaths()` from `src/utils/apps.js` to enumerate every HTML file → `src/utils/transform.js` rewrites URLs and injects chrome → static output in `dist/`.

### Key Source Files

- `src/pages/[...path].astro` — Catchall route, renders every sub-app page. Injects `<ClientRouter />` for Astro client-side transitions.
- `src/pages/index.astro` — Landing catalog page
- `src/utils/apps.js` — `getAppPages()` enumerates sub-app HTML (manifest-driven or filesystem crawl)
- `src/utils/transform.js` — `transformSubAppHtml()`: URL rewriting, chrome injection, headless transforms
- `src/templates/chrome.js` — Chrome HTML template + client-side SPA router script
- `scripts/build-vite.js` — Build orchestrator (3-step pipeline)
- `scripts/fetch-apps.js` — GitHub Release artifact downloader

### Two Modes

**Non-headless** (standalone): Injects chrome bar, SPA router, theme toggle. Client-side router intercepts navigation, fetches HTML, swaps DOM content.

**Headless** (web-fragment): Strips dark mode class, marks `data-mp-headless="true"`, injects shadow DOM compat styles. No chrome bar. Designed for embedding in a web-fragments gateway.

### URL Rewriting

`transform.js` rewrites all relative and root-relative URLs to absolute `/{prefix}/{slug}/...` paths. Runs before chrome injection to prevent double-rewriting. Removes `<base>` tags.

## Contract for Doc Apps

Apps registered in `apps.json` must comply with:
- `contract/schema.json` — JSON Schema for `marketplace.json` manifest
- `contract/HEADLESS_RULES.md` — Structural requirements (headless HTML, relative paths, `data-mp-headless` attribute)
- `contract/STYLE_GUIDE.md` — Design tokens, typography, dark mode support

## Testing

Playwright tests run against the web-fragments gateway at `https://localhost:4201`. The `webServer` config auto-starts knowledge-base on `:3000` via `build:local:headless + preview:embedded`. The gateway must be started separately.

Tests exercise shadow DOM penetration (`wf-html`, `wf-document` custom elements), fragment lifecycle, and marketplace navigation.

## Environment Variables

- `GITHUB_TOKEN` — GitHub API auth for fetching Release artifacts
- `MP_HEADLESS` — `true`/`false`, controls headless mode
- `MP_PREFIX` — URL prefix (default: `knowledge-base`)
- `AWS_REGION`, `ECR_REPOSITORY`, `ECS_CLUSTER`, `ECS_SERVICE` — deployment config
