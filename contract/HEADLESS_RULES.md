# Headless Build Rules

Doc apps included in the knowledge base must produce **headless HTML output** — pages that
contain content (sidebar + prose) but **do not** include a site-level top navigation bar.
The knowledge base re-hosts every page under its own persistent masthead, which carries the
branding and the Library / current-app navigation.

> **Simpler alternative — single-page docs.** If what you have is a markdown file or
> two rather than a documentation *site*, none of this applies to you. Add the
> `publish-single-page-docs` action to your repo and it produces a compliant artifact
> for you — no headless build, no manifest to write, no config. See
> [`SINGLE_PAGE.md`](./SINGLE_PAGE.md).

> **Temporary alternative — iframe onboarding.** Teams that already host their docs
> elsewhere and cannot yet produce a headless package can be listed immediately with an
> `apps.json` entry of `"type": "iframe"` + a `"url"` (no manifest, no release
> artifact, no headless build). The page is rendered as a full-viewport `<iframe>` inside
> the knowledge base chrome. This is an **explicit stopgap** — such entries should carry
> `"temporary": true` and be migrated to a proper headless package when possible. The
> external site must allow embedding (its CSP `frame-ancestors` / `X-Frame-Options` must
> not block the knowledge base origin). See issue #10.

---

## Required: Headless build flag

Your build script must support a `--headless` CLI flag that produces headless output.

```bash
# Headless build (used by knowledge base and release workflow)
npm run build -- --headless

# Standalone build (for local dev / preview)
npm run build
```

When `--headless` is active:

| Requirement | Detail |
|---|---|
| **No global `<header>`** | Do not render the site-level fixed top bar that contains the app logo and main navigation links. |
| **Sidebar offset** | Set sidebar's `top` to `0`. The knowledge base no longer injects a fixed bar, so nothing is reserved above your content. |
| **`data-kb-headless` attribute** | Add `data-kb-headless="true"` to the `<html>` element so the knowledge base can identify and verify headless pages. |
| **Theme toggle** | Omit the theme toggle button from the site header. The knowledge base is light only and strips any theme bootstrap your page ships. |
| **Relative asset paths** | All `href`, `src`, `action` attribute values must be **relative** (no leading `/`). The knowledge base mounts apps at `/knowledge-base/{slug}/`, so absolute paths will 404. |

---

## Required: `kb-docs.json` manifest

Place a `kb-docs.json` file in the **root of your repository**. It must validate
against the [JSON Schema](./kb-docs.schema.json); the publishing action does that
for you before it packs anything.

```json
{
  "kbVersion": "1",
  "apps": [
    {
      "slug": "my-app",
      "name": "My App Documentation",
      "description": "A clear, one-sentence description of what this documentation covers.",
      "icon": "book-open",
      "tags": ["example", "guide"],
      "entryPoint": "index.html",
      "pages": [
        { "title": "Overview",        "path": "index.html",                 "order": 1 },
        { "title": "Getting Started", "path": "getting-started/index.html", "order": 2 },
        { "title": "Configuration",   "path": "configuration/index.html",   "order": 3, "section": "Reference" }
      ]
    }
  ]
}
```

A documentation site is one entry in `apps`. The list exists because a single
repo may publish several independent docs from one release — see
[`SINGLE_PAGE.md`](./SINGLE_PAGE.md) — and the knowledge base reads both through
the same manifest.

Every field is specified in [`ARTIFACT.md`](./ARTIFACT.md), which is normative.
The two worth reading before you start:

- **`slug`** becomes your public URL (`/knowledge-base/{slug}/`) and the name of
  your app's directory inside the archive. It must be unique across the *whole*
  knowledge base, so prefix it with your service name.
- **`pages`** is optional but recommended. When present it is the authoritative
  route list, with your titles and your ordering. Absent, the knowledge base
  crawls your output for HTML and derives titles from the documents. Generate it
  from whatever your site generator already knows about its navigation.

---

## Required: HTML structure

The `<body>` of each doc page must follow this structure:

```html
<body>
  <!-- ✅ Sidebar — yours, kept as-is -->
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
[`src/styles/knowledge-base.css`](../src/styles/knowledge-base.css) in this repository.  
There is deliberately no `.dark` set — the knowledge base is light-only.

---

## Required: GitHub Release artifact

Your repo must attach **`kb-docs.tar.gz`** to a GitHub Release whenever the docs
change. Its layout — the manifest at the root, one directory per app — is
specified in [`ARTIFACT.md`](./ARTIFACT.md).

You do not assemble it by hand. Build your site, then hand the output to the
publishing action, which validates the manifest, checks the HTML against the
rules on this page, packs the archive and uploads it:

```yaml
# .github/workflows/publish-docs.yml in your doc repo
name: Publish docs

on:
  release:
    types: [published]
  workflow_dispatch:

permissions:
  contents: write        # required — the action uploads a release asset

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Whatever your site generator is. The action does not build for you.
      - run: npm ci && npm run build -- --headless

      - uses: AbsaOSS/knowledge-base/actions/publish-docs@v1
        with:
          manifest: kb-docs.json
          dist: dist
```

Pin the action to a major tag (`@v1`), not to a branch. A breaking contract
change ships as `@v2`, so a pinned major keeps publishing until you choose to
move.

---

## Checklist

Before opening a PR to add your app to `apps.json`:

- [ ] `kb-docs.json` is in the repo root and validates against [`contract/kb-docs.schema.json`](./kb-docs.schema.json)
- [ ] Your headless build succeeds and produces the output directory named in the workflow
- [ ] That directory contains `index.html` (or your configured `entryPoint`)
- [ ] No `<header class="fixed top-0...">` present in any headless HTML page
- [ ] `data-kb-headless="true"` is on the `<html>` element
- [ ] All asset paths are relative (no leading `/`)
- [ ] Design tokens are defined in your CSS
- [ ] A GitHub Release with `kb-docs.tar.gz` exists on your repo
