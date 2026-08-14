# knowledge-base

> A unified documentation portal — wraps independently-maintained doc apps into a
> single deployable with a persistent branded masthead, and can be embedded as a
> web fragment inside a host app.

---

## What it is

`knowledge-base` is a **build-time aggregator** for static documentation sites. At
build time it:

1. Obtains each registered app's built output (`dist/`) — from a **GitHub Release
   artifact** (`dist.tar.gz`), a **local repo**, or a **prebuilt** tarball/dir.
2. Rewrites every page's URLs to absolute `/knowledge-base/{slug}/…` paths and,
   in standalone mode, injects a persistent top **chrome** (nav + app switcher).
3. Generates a **catalog landing page** listing all registered apps.
4. Produces a single `dist/` served by **nginx** in Docker, or embedded into a
   host app as a **web fragment**.

Each app keeps its own sidebar, routing, and internal navigation.

---

## Architecture

```
Browser ──► host origin ──► /knowledge-base/                 (landing catalog)
                            /knowledge-base/{slug}/…          (each doc app)
                            /__wf/knowledge-base/…            (fragment assets)
                                  │
                                  ▼
                    nginx (Docker)  ─or─  web-fragments gateway (embedded)
                                  │
                                  ▼
                              dist/  (static)
```

When **embedded**, a host app's [web-fragments](https://web-fragments.dev)
gateway proxies the `/knowledge-base/*` routes onto the host's single origin and
reframes the markup into a shadow root — no full page reload between pages.

---

## Quick start

Prerequisites: **Node.js ≥ 24**. For the GitHub-fetch build, `gh` CLI
authenticated (or `GITHUB_TOKEN` set).

```bash
npm install

# Hermetic build from the vendored docs-example fixture (no network/token):
npm run build:headless

# E2E tests (Playwright — auto-starts its own servers):
npm test
```

### Build modes

| Command | Source of apps |
|---|---|
| `npm run build` | Fetch GitHub Release artifacts (needs `GITHUB_TOKEN`/`gh`) |
| `npm run build:headless` | Same fetch, headless/web-fragment output |
| `npm run build:local` | Build each app from a local checkout (`localPath`) |
| `npm run build:local:headless` | Local + headless |

`--headless` (or `MP_HEADLESS=true`) produces fragment-ready output: no chrome
bar, `data-mp-headless="true"` on `<html>`, shadow-DOM compat styles.

Orchestrator: `scripts/build-vite.js` (flags: `--local`, `--headless`,
`--path-prefix=`).

---

## The registry: `apps.json`

Each entry registers one doc app. A `slug` is required; the source is one of
`repo` (+ optional `version`), `localPath`, `prebuilt`, or an `iframe` URL:

```jsonc
[
  {
    "slug": "my-app",
    "name": "My App Documentation",
    "description": "What this app documents.",
    "icon": "book-open",
    "tags": ["guide"],

    // pick ONE source:
    "repo": "AbsaOSS/my-docs", "version": "latest", // GitHub Release artifact
    // "localPath": "../my-docs",                    // build from local checkout
    // "prebuilt": "tests/fixtures/my-docs.dist.tar.gz" // prebuilt tarball or dist dir
  }
]
```

Add `"optional": true` to a `prebuilt`/`localPath` entry whose artifact lives
outside this repo — a sibling checkout, say. The build then **skips it with a
warning** when the artifact is absent instead of failing, so CI and fresh clones
stay green while a developer who has the sibling repo gets the app. Entries
without the flag still hard-fail on a missing artifact, so a lost fixture can
never quietly produce an empty deployment.

### iframe onboarding (temporary)

Teams that already host their docs elsewhere and can't yet produce a headless
package can be listed immediately with an **iframe** entry — no `repo`,
`marketplace.json`, or artifact needed. It renders as a full-viewport `<iframe>`
inside the marketplace chrome and shows an **External** badge in the catalogue.

```jsonc
{
  "type": "iframe",
  "url": "https://my-team.example.com/docs",
  "slug": "my-team",
  "name": "My Team Docs",
  "description": "...",
  "icon": "book-open",
  "tags": ["my-team"],
  "temporary": true          // stopgap — migrate to a headless package when ready
}
```

The external site must permit embedding (its CSP `frame-ancestors` /
`X-Frame-Options` must not block the marketplace origin). See issue #10.

### single-page onboarding (markdown, zero config)

Teams whose "docs" are just a markdown file or two don't need a docs site at all.
They add **one workflow file** to their repo:

```yaml
# .github/workflows/publish-docs.yml in the docs repo
on:
  release:
    types: [published]
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: AbsaOSS/knowledge-base/actions/publish-single-page-docs@master
        with:
          docs: |
            - md: docs/overview.md
              title: Service Overview
              description: What the service does and how to use it.
              slug: my-service
```

The action ([`actions/publish-single-page-docs/`](actions/publish-single-page-docs)) renders the markdown
to headless HTML — GFM tables, task lists, footnotes, highlighted code and
vendored-mermaid diagrams — packs every doc into one `dist.tar.gz` with a
`bundle.json` manifest, and attaches it to the repo's latest release.

The registry entry then carries **no per-doc metadata at all**:

```jsonc
{
  "repo": "AbsaOSS/my-service",
  "type": "single-page",
  "version": "latest"
}
```

The build reads `bundle.json` and expands that one entry into one app per doc —
each with its own catalogue card and URL — so adding or renaming a doc later
never touches this repository again. Pages render with the masthead and a centred
reading column, no sidebar. See [`contract/SINGLE_PAGE.md`](contract/SINGLE_PAGE.md)
and issue #35.

#### Seeing it for real

`knowledge-base-example-single-page` is a mock docs repo — three markdown files
and the workflow above, nothing else — whose `dist.tar.gz` is produced by the
real action. Check it out next to this repo and:

```bash
npm run build:local && npm run preview
```

then open <http://localhost:4321/knowledge-base/>. The committed `apps.json`
already registers it as an `optional` entry, so nothing breaks when it is absent.

The repo ships an `apps.json` that registers the **vendored docs-example fixture**
twice (`user-guide`, `guide-mirror`), an iframe entry, a **single-page bundle
fixture** (`platform-overview`, `release-process`), and the optional example repo
above — so the build and tests are hermetic out of the box. Replace it with your
own apps for a real deployment.

---

## Testing

E2E tests use Playwright. Everything is hermetic — built from
`tests/fixtures/docs-example.dist.tar.gz` (no network, token, or sibling repo).

| Command | Layer |
|---|---|
| `npm test` | **Embedded** harness (`playwright.config.js`). Starts the fragment server (`:3000`) and a minimal web-fragments **host gateway** (`tests/host/server.mjs`, `:4201`) that embeds the fragment. Covers shadow-DOM isolation, smooth no-reload SPA routing, cross-app navigation, asset 404s, and the fragment-history limitation. |
| `npx playwright test --config=playwright.config.ci.js` | **Standalone** layer. Hits the fragment server (`tests/fragment-server.mjs`, `:3000`) directly. Covers HTTP header safety (`X-Frame-Options`), the headless contract, CSS-link stability (web-fragments [#297](https://github.com/web-fragments/web-fragments/issues/297)), and asset routing. |

> `tests/fragment-server.mjs` serves `dist/` and mirrors the production
> `nginx.conf` rewrites (including `/__wf/knowledge-base/* → /knowledge-base/*`).
> `astro preview` is **not** used as the fragment endpoint: its Vite
> `configurePreviewServer` rewrite hook does not run for static output, so the
> `/__wf` asset route would 404.

Both layers run in CI (`.github/workflows/ci.yml`).

---

## Embedding as a web fragment

`knowledge-base` can run as a web fragment inside any host app that uses a
web-fragments gateway (Express/Node, Cloudflare, Angular SSR, …).
`tests/host/server.mjs` is a minimal, runnable reference host.

**Fragment server (this repo):** serve the built `dist/` mirroring the nginx
rewrites — e.g. `node tests/fragment-server.mjs` (port 3000), or nginx in Docker.

**Host gateway registration:**

```js
import { FragmentGateway } from 'web-fragments/gateway';
import { getNodeMiddleware } from 'web-fragments/gateway/node';

const gateway = new FragmentGateway();
gateway.registerFragment({
  fragmentId: 'knowledge-base',
  endpoint: 'http://localhost:3000',          // the fragment server
  piercing: false,
  routePatterns: [
    '/knowledge-base/:_*',                     // landing + sub-app pages + assets
    '/__wf/knowledge-base/:_*',                // fragment asset prefix
  ],
});
app.use(getNodeMiddleware(gateway));           // before host static/catch-all routes
```

**Host page:**

```html
<script type="importmap">{ "imports": { "web-fragments": "/_wf/elements.js" } }</script>
<web-fragment fragment-id="knowledge-base" src="/knowledge-base/"></web-fragment>
<script type="module">
  import { initializeWebFragments } from 'web-fragments';
  initializeWebFragments();
</script>
```

> Fragment-internal routes are not mirrored to the host's top-window history and
> are not address-bar deep-linkable — design host-level routing if you need that.

---

## Contract for doc apps

Apps must comply with the marketplace contract before they can be registered:

| Document | Description |
|---|---|
| [`contract/schema.json`](contract/schema.json) | JSON Schema for `marketplace.json` |
| [`contract/HEADLESS_RULES.md`](contract/HEADLESS_RULES.md) | Headless HTML, relative paths, `data-mp-headless` |
| [`contract/STYLE_GUIDE.md`](contract/STYLE_GUIDE.md) | Design tokens (`--color-kb-*`), typography, dark mode |
| [`contract/SINGLE_PAGE.md`](contract/SINGLE_PAGE.md) | `bundle.json` format + zero-config markdown onboarding |

> The checklist and workflows below apply to **packaged** doc apps. Single-page
> docs skip all of it — the action produces a compliant artifact for you.

### Checklist
- [ ] `marketplace.json` in repo root, valid against `contract/schema.json`
- [ ] `npm run build -- --headless` produces a headless `dist/`
- [ ] `data-mp-headless="true"` on `<html>` in headless output
- [ ] No fixed site-level header in headless output
- [ ] All asset paths relative (no leading `/`)
- [ ] GitHub Release tagged `v*` with a `dist.tar.gz` asset

### Reusable validation workflow

Doc repos can enforce the contract in their own CI:

```yaml
# .github/workflows/validate.yml (in your doc repo)
on: [push, pull_request]
jobs:
  validate:
    uses: AbsaOSS/knowledge-base/.github/workflows/validate-doc-app.yml@master
```

### Release workflow for doc repos

```yaml
# .github/workflows/release.yml (in your doc repo)
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with: { node-version: '24', cache: npm }
      - run: npm ci
      - run: npm run build -- --headless
      - run: tar -czf dist.tar.gz dist/ marketplace.json
      - uses: softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65 # v2.6.2
        with:
          files: dist.tar.gz
```

---

## Deployment

Built as a Docker image (nginx serving static files).

```bash
docker build -t knowledge-base .
docker run -p 8080:8080 knowledge-base   # http://localhost:8080/knowledge-base/
```

### Deploy configuration (example — AWS ECS)

| Variable | Description |
|---|---|
| `AWS_REGION` | AWS region for ECR + ECS |
| `ECR_REPOSITORY` | ECR repository name |
| `ECS_CLUSTER` / `ECS_SERVICE` | ECS cluster / service name |

Provide `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (or an OIDC role) with ECR
push + ECS deploy permissions via repository secrets.

---

## Project structure

```
knowledge-base/
├── apps.json                  ← Registry of doc apps
├── astro.config.mjs           ← Astro SSG config (base /knowledge-base)
├── actions/publish-single-page-docs/      ← Reusable action: markdown → single-page bundle
├── src/
│   ├── pages/
│   │   ├── index.astro        ← Landing catalog
│   │   └── [...path].astro    ← Catch-all: renders every sub-app page
│   ├── layouts/Base.astro
│   ├── components/            ← AppCard, AppIcon, Masthead
│   ├── templates/shadow-compat.js ← Shadow-DOM design-token styles
│   ├── styles/marketplace.css ← Design tokens + Tailwind
│   └── utils/
│       ├── apps.js            ← loadRegistry() + getAppPages() page enumeration
│       ├── single-page.js     ← bundle.json parsing + registry expansion
│       └── transform.js       ← URL rewriting + sub-app document splitting
├── scripts/
│   ├── build-vite.js          ← Build orchestrator
│   ├── fetch-apps.js          ← GitHub Release download + extract
│   └── setup-test-apps.mjs    ← Generates the hermetic test apps.json
├── tests/
│   ├── web-fragment.spec.js   ← Embedded harness suite
│   ├── standalone.spec.js     ← Standalone fragment-server suite
│   ├── build-integrity.spec.js
│   ├── artifact-safety.spec.js ← Tarball extraction guards
│   ├── nginx-config.spec.js   ← nginx header-inheritance guard (static)
│   ├── container.spec.js      ← Integration suite vs. the real nginx image
│   ├── container/serve.mjs    ← Builds + runs the image for that suite
│   ├── host/server.mjs        ← Reference web-fragments host (gateway)
│   ├── fragment-server.mjs    ← nginx-mirroring static server
│   ├── support/fragment.js    ← Shadow-DOM test helpers
│   └── fixtures/              ← Vendored docs-example dist.tar.gz + single-page bundle
├── contract/                  ← marketplace.json schema + rules + style guide
├── .github/workflows/         ← ci.yml, validate-doc-app.yml
├── Dockerfile
├── nginx.conf                 ← server block (rewrites, caching, routing)
└── nginx.headers.conf         ← shared CORS + security headers, included by
                                 every block in nginx.conf that sets a header
```

---

## Contributing & security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
