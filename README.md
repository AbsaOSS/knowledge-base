# knowledge-base

> A unified documentation portal — wraps independently-maintained doc apps into
> a single deployable with a persistent branded chrome.

---

## What it is

`knowledge-base` is a **build-time aggregator** for static documentation sites hosted
across multiple GitHub repositories.

At build time it:
1. Downloads each registered app's **GitHub Release artifact** (`dist.tar.gz`)
2. **Injects the marketplace top chrome** (56 px persistent nav with app switcher) into every HTML page
3. Generates a **catalog landing page** listing all available apps
4. Produces a single `dist/` directory served by nginx in Docker → AWS ECS

Each app retains its own sidebar, routing, and internal navigation. The marketplace
adds the persistent top bar and gives users a consistent entry point.

---

## Architecture

```
Browser  →  https://docs.internal/
                  │
                  ▼
       ┌──────────────────────────────┐
       │   Marketplace top chrome     │  ← injected at build time
       │   [Logo] Docs / App ▾       │     persists on every page
       └──────────────────────────────┘
       │                              │
       │   Sub-site content           │  ← from dist/apps/{slug}/
       │   (sidebar + prose)          │     built headless by each repo
       │                              │
       └──────────────────────────────┘
                  │
                  ▼
          nginx (Docker) → ECS
```

---

## Registered apps

Apps are listed in [`apps.json`](apps.json):

| App | Slug | Repo | URL |
|---|---|---|---|
| Example Docs | `example` | `AbsaOSS/example-docs` | `/apps/example/` |

---

## Local development

### Prerequisites
- Node.js ≥ 20
- `gh` CLI authenticated (or `GITHUB_TOKEN` env var set)

### Build with live artifacts

```bash
npm install
npm run build        # fetches GitHub Release artifacts + injects chrome
npx serve dist -p 3000
```

### Build in local mode (no GitHub fetch)

If you've already run a full build or have manually placed artifacts:

```bash
# Place a headless-built dist/ under tmp/apps/{slug}/dist/
mkdir -p tmp/apps/my-app
# ... copy dist/ from a headless doc build ...

npm run build:dev -- --local
```

### Adding a new app

1. **In the doc repo:** follow the [contract](contract/HEADLESS_RULES.md)
   - Add `marketplace.json` to repo root
   - Support `--headless` build flag
   - Publish GitHub Release with `dist.tar.gz`

2. **In this repo:** add an entry to `apps.json`:
   ```json
   {
     "repo": "AbsaOSS/my-new-docs",
     "slug": "my-app",
     "name": "My App Documentation",
     "description": "What this app documents.",
     "icon": "book-open",
     "tags": ["guide"],
     "version": "latest"
   }
   ```

3. Open a PR — the CI will validate the contract before merging.

---

## Contract for doc apps

All apps must comply with the marketplace contract before they can be registered.

| Document | Description |
|---|---|
| [`contract/schema.json`](contract/schema.json) | JSON Schema for `marketplace.json` |
| [`contract/HEADLESS_RULES.md`](contract/HEADLESS_RULES.md) | Structural requirements (headless HTML, relative paths, etc.) |
| [`contract/STYLE_GUIDE.md`](contract/STYLE_GUIDE.md) | Visual style requirements (design tokens, typography, dark mode) |

### Quick checklist
- [ ] `marketplace.json` in repo root, validates against `contract/schema.json`
- [ ] `npm run build -- --headless` succeeds → produces headless `dist/`
- [ ] `data-mp-headless="true"` on `<html>` in headless output
- [ ] No fixed site-level `<header>` in headless output
- [ ] All asset paths are relative (no leading `/`)
- [ ] Design tokens (`--color-kb-500` etc.) in CSS
- [ ] GitHub Release tagged `v*` with `dist.tar.gz` asset
- [ ] References the marketplace's reusable `validate-doc-app.yml` workflow

### Reusable validation workflow

Doc repos should call the marketplace's reusable workflow to enforce the contract in CI:

```yaml
# .github/workflows/validate.yml (in your doc repo)
name: Validate

on: [push, pull_request]

jobs:
  validate:
    uses: AbsaOSS/knowledge-base/.github/workflows/validate-doc-app.yml@main
    secrets: inherit
```

### Release workflow for doc repos

```yaml
# .github/workflows/release.yml (in your doc repo)
name: Release

on:
  push:
    tags: ['v*']

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - run: npm run build -- --headless
      - name: Package dist
        run: tar -czf dist.tar.gz dist/ marketplace.json
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist.tar.gz
```

---

## Embedding in data-gateway (web-fragments)

`knowledge-base` can run as a [web-fragment](https://web-fragments.dev) inside the
`data-gateway` Angular SSR app, appearing at the `/knowledge-base` route without a
full page reload.

### Fragment server (this repo)

Run the fragment server **without compression** — the web-fragments gateway processes
the HTML before sending it to the browser, and compression confuses the pipeline:

```bash
npm run build:local:headless          # build with headless flag
npm run preview:embedded              # serves on http://localhost:3000/knowledge-base/
```

> **Why not `npm run preview`?** `vite preview` adds brotli/gzip compression which
> causes `ERR_CONTENT_DECODING_FAILED` in the web-fragments gateway. `preview:embedded`
> uses `scripts/preview.js` — a zero-dependency server with no compression.

### data-gateway registration (`src/server.ts`)

Add the fragment alongside the existing registrations:

```typescript
gateway.registerFragment({
  fragmentId: 'knowledge-base',
  piercingClassNames: [],
  endpoint: environment.fragments.docsMarketplace.endpoint,  // e.g. http://localhost:3000
  routePatterns: [
    '/knowledge-base',       // bare path without trailing slash
    '/knowledge-base/:_*',   // landing page + all sub-app pages and assets
  ],
  piercing: false,
});
```

Add the endpoint to `src/environments/environment.ts`:

```typescript
docsMarketplace: {
  endpoint: 'http://localhost:3000',
},
```

### data-gateway template

Create the Angular component and template at the `/knowledge-base` route:

```html
<!-- src/app/routes/knowledge-base/knowledge-base.html -->
<web-fragment fragment-id="knowledge-base" />
```

```typescript
// knowledge-base.ts
@Component({
  selector: 'app-knowledge-base',
  templateUrl: './knowledge-base.html',
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
})
export class DocsMarketplaceComponent {}
```

---

## Deployment

Built as a Docker image (nginx serving static files) deployed to AWS ECS.

### Environment variables / GitHub repo variables

| Name | Description | Default |
|---|---|---|
| `AWS_REGION` | AWS region for ECR + ECS | `eu-west-1` |
| `ECR_REPOSITORY` | ECR repository name | `knowledge-base` |
| `ECS_CLUSTER` | ECS cluster name | `knowledge-base` |
| `ECS_SERVICE` | ECS service name | `knowledge-base` |
| `DEPLOY_URL` | Public URL of the deployment | — |

### Secrets required

| Secret | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | IAM access key with ECR push + ECS deploy permissions |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key |

### Manual deploy

```bash
docker build -t knowledge-base .
docker run -p 8080:8080 knowledge-base
```

---

## Project structure

```
knowledge-base/
├── apps.json                    ← Registry of all doc apps
├── package.json
├── src/
│   ├── input.css                ← Design tokens + marketplace styles
│   └── templates/
│       ├── chrome.js            ← Persistent top nav HTML template
│       └── landing.js           ← Catalog landing page template
├── scripts/
│   ├── build.js                 ← Main build orchestrator
│   ├── fetch-apps.js            ← GitHub Release download + extract
│   └── inject-chrome.js        ← HTML chrome injection
├── contract/
│   ├── schema.json              ← marketplace.json JSON Schema
│   ├── HEADLESS_RULES.md        ← Headless HTML contract
│   └── STYLE_GUIDE.md           ← Visual style requirements
├── .github/
│   └── workflows/
│       ├── build-deploy.yml     ← Marketplace CI/CD (push to main → ECR → ECS)
│       └── validate-doc-app.yml ← Reusable validation workflow for doc repos
├── Dockerfile
├── nginx.conf
└── README.md
```
