# Headless Build Rules

Doc apps included in the marketplace must produce **headless HTML output** — pages that
contain content (sidebar + prose) but **do not** include a site-level top navigation bar.
The marketplace injects its own persistent 56 px chrome at the top of every page.

> **Temporary alternative — iframe onboarding.** Teams that already host their docs
> elsewhere and cannot yet produce a headless package can be listed immediately with an
> `apps.json` entry of `"type": "iframe"` + a `"url"` (no `marketplace.json`, no release
> artifact, no headless build). The page is rendered as a full-viewport `<iframe>` inside
> the marketplace chrome. This is an **explicit stopgap** — such entries should carry
> `"temporary": true` and be migrated to a proper headless package when possible. The
> external site must allow embedding (its CSP `frame-ancestors` / `X-Frame-Options` must
> not block the marketplace origin). See issue #10.

---

## Required: Headless build flag

Your build script must support a `--headless` CLI flag that produces headless output.

```bash
# Headless build (used by marketplace and release workflow)
npm run build -- --headless

# Standalone build (for local dev / preview)
npm run build
```

When `--headless` is active:

| Requirement | Detail |
|---|---|
| **No global `<header>`** | Do not render the site-level fixed top bar that contains the app logo and main navigation links. |
| **Sidebar offset** | Set sidebar's `top` to `0` (marketplace resets it to `var(--mp-chrome-h)` via injected CSS). |
| **`data-mp-headless` attribute** | Add `data-mp-headless="true"` to the `<html>` element so the marketplace can identify and verify headless pages. |
| **Theme toggle** | Omit the theme toggle button from the site header. The marketplace chrome provides its own. |
| **Relative asset paths** | All `href`, `src`, `action` attribute values must be **relative** (no leading `/`). The marketplace mounts apps at `/apps/{slug}/`, so absolute paths will 404. |

---

## Required: `marketplace.json` manifest

Place a `marketplace.json` file in the **root of your repository** (not in `dist/`).  
It must validate against the [JSON Schema](./schema.json).

```json
{
  "marketplaceVersion": "1",
  "name": "My App Documentation",
  "slug": "my-app",
  "description": "A clear, one-paragraph description of what this documentation covers.",
  "icon": "book-open",
  "tags": ["example", "guide"],
  "entryPoint": "index.html",
  "pages": [
    { "title": "Overview",        "path": "index.html",                 "order": 1 },
    { "title": "Getting Started", "path": "getting-started/index.html", "order": 2 },
    { "title": "Configuration",   "path": "configuration/index.html",   "order": 3, "section": "Reference" }
  ]
}
```

### Recommended: `pages` navigation manifest

The optional `pages` array tells the marketplace the **exact set of routes** your app exposes, along with human-readable titles and ordering. When present it replaces the default filesystem crawl used to discover HTML files.

| Field | Required | Description |
|-------|----------|-------------|
| `title` | ✅ | Page title shown in sidebar navigation |
| `path` | ✅ | Path to the HTML file relative to `dist/` |
| `order` | ✅ | Integer sort position (lower = higher up) |
| `section` | ☐ | Optional sidebar section/group heading |

> **Note:** `pages` should be written into `dist/marketplace.json` (not the root `marketplace.json`) by your build script at build time. See the example app for a reference implementation that generates this from MkDocs navigation config.
>
> If `pages` is absent the marketplace falls back to crawling all `.html` files in `dist/` — existing apps require no changes.

### Slug rules
- Lowercase letters, numbers, and hyphens only: `^[a-z0-9-]+$`
- Must be unique across all apps in `apps.json`
- Becomes the URL prefix: `/apps/{slug}/`

---

## Required: HTML structure

The `<body>` of each doc page must follow this structure:

```html
<body>
  <!-- ✅ Sidebar — marketplace repositions top offset -->
  <nav id="sidebar" class="fixed top-0 ...">
    ...
  </nav>

  <!-- ✅ Main content -->
  <main id="content" class="ml-64 ...">
    ...
  </main>

  <!-- ✅ Overlay for mobile sidebar -->
  <div id="overlay" ...></div>
</body>
```

**Prohibited elements in `<body>` when headless:**

```html
<!-- ❌ Site-level fixed top bar — must be absent in headless mode -->
<header class="fixed top-0 inset-x-0 ...">
  <a href="...">MyApp Logo</a>
  <nav>... top links ...</nav>
</header>
```

---

## Required: design tokens

Your CSS must define (or import) the canonical design tokens.  
At minimum the following CSS custom properties must be present:

```css
--color-kb-500, --color-kb-600
--bg-page, --bg-card, --bg-subtle, --bg-strong
--border, --border-subtle
--text-heading, --text-body, --text-muted
```

Copy the `@theme` block and `:root` variable declarations from  
[`src/styles/marketplace.css`](../src/styles/marketplace.css) in this repository.  
There is deliberately no `.dark` set — the marketplace is light-only.

---

## Required: GitHub Release artifact

Your repo must publish a **GitHub Release** containing `dist.tar.gz` whenever docs are updated.  
The archive must unpack to a `dist/` directory containing the headless HTML output.

Use the reusable release workflow — see [`.github/workflows/validate-doc-app.yml`](../.github/workflows/validate-doc-app.yml).

```yaml
# .github/workflows/release.yml in your doc repo
name: Release

on:
  push:
    tags: ['v*']

jobs:
  release:
    uses: AbsaOSS/knowledge-base/.github/workflows/validate-doc-app.yml@main
    secrets: inherit
```

---

## Checklist

Before opening a PR to add your app to `apps.json`:

- [ ] `marketplace.json` is in the repo root and validates against `contract/schema.json`
- [ ] `npm run build -- --headless` succeeds and produces `dist/`
- [ ] `dist/` contains `index.html` (or your configured `entryPoint`)
- [ ] No `<header class="fixed top-0...">` present in any headless HTML page
- [ ] `data-mp-headless="true"` is on the `<html>` element
- [ ] All asset paths are relative (no leading `/`)
- [ ] Design tokens are defined in your CSS
- [ ] A GitHub Release with `dist.tar.gz` exists on your repo
