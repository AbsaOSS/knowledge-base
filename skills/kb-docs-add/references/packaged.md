# Packaged path

The repo keeps its own site generator. You make that generator's output headless, describe
the output in `kb-docs.json`, and add one workflow that builds and hands the output to
the `publish-docs` action. The action validates the manifest against the schema, checks
every HTML file against the headless rules, packs `kb-docs.tar.gz` and uploads it.
Normative text: `contract/HEADLESS_RULES.md` and `contract/ARTIFACT.md` in
`AbsaOSS/knowledge-base`.

Three files, in this order, because each one is checked by the next.

## A. Headless output from the existing build

The knowledge base re-hosts each page under its own masthead, so the page must arrive
without the chrome the masthead replaces. What the built HTML must satisfy:

| Requirement | Why |
|---|---|
| `data-kb-headless="true"` on `<html>` | How the knowledge base and the action recognise a headless page. The pre-v1 `data-mp-headless` is rejected. |
| No site-level fixed `<header>` (logo + top links) | The masthead is that header now. A sidebar is fine and expected. |
| No theme toggle, no `localStorage` theme bootstrap | The knowledge base is light only and strips any theme script that slips through. |
| Every `href`/`src`/`action`/`poster` **relative** (no leading `/`) | The app is mounted at `/knowledge-base/{slug}/`; root-relative paths 404 there. |
| No `<base>` element | It would re-resolve every URL once the page is re-hosted. |
| Design tokens present in the CSS | `--color-kb-500/600`, `--bg-page/card/subtle/strong`, `--border/-subtle`, `--text-heading/body/muted`. Copy the `:root` block from `src/styles/knowledge-base.css` in the knowledge base repo. |

Inline `<script>` is a warning, not a failure: the knowledge base hoists it into files
so it can serve `script-src 'self'`.

The tokens, ready to paste into the site's stylesheet when it does not already define
them. Brand values are the ones `contract/STYLE_GUIDE.md` fixes; the neutral values are
the knowledge base's own greys, so a page reads as one surface with the masthead:

```css
:root {
  --color-kb-500: #af144b;   /* primary brand, links, active states */
  --color-kb-600: #93103f;   /* hover on primary elements */
  --bg-page:      #fdf8f9;   /* kb-25 */
  --bg-card:      #ffffff;
  --bg-strong:    #f9fafb;
  --bg-subtle:    #f3f4f6;
  --border:       #e5e7eb;
  --border-subtle:#f3e7eb;
  --text-heading: #1b0e12;   /* kb-950 */
  --text-body:    #4b5563;
  --text-muted:   #6b7280;
}
```

Add only the names the stylesheet lacks. Do not restyle the site around them — the
tokens exist so shared components render consistently, not to repaint a theme.

How to get there depends on the generator, but the principle is constant: **a build
variant, not a fork.** The standalone site keeps working; the release workflow calls the
variant.

- **npm-based site with its own templates** (Astro, Eleventy, hand-rolled): the contract
  convention is a `--headless` flag on the build script. Thread it to the layout: emit the
  attribute, skip the header and toggle when set.
- **mkdocs**: a second config that inherits the first and sets a flag, plus a one-line
  condition in the theme template. This is the whole change in the reference example:

  ```yaml
  # mkdocs-headless.yml
  INHERIT: mkdocs.yml
  extra:
    headless: true
  ```

  ```html
  <html lang="en"{% if config.extra.headless %} data-kb-headless="true"{% endif %}>
  ```

  Then hide the header block under the same condition and build with
  `mkdocs build -f mkdocs-headless.yml`. Leave `site_url` unset so links stay relative.
- **Docusaurus, Starlight, mkdocs-material or any third-party theme you do not own**:
  check whether the theme exposes a swizzle/override for the header and for the `<html>`
  attributes. If it does, the change is still small — do it. If getting rid of the header
  means re-implementing the theme, stop and report: list the exact failing requirements
  from the table above, and offer the single-page path for the markdown sources instead.
  A half-headless site in the knowledge base is worse than markdown that renders cleanly.

After the change, build the variant and check the output yourself — the same greps the
action runs:

```bash
grep -L 'data-kb-headless="true"' $(find dist -name '*.html')   # must print nothing
grep -rlE '(href|src|action|poster)="/' dist                     # must print nothing
grep -rl '<base' dist                                            # must print nothing
```

## B. `kb-docs.json` in the repo root

Start from `examples/kb-docs.json` (the contract's own copy) and describe *this* site:

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

| Field | Required | Rules |
|---|---|---|
| `kbVersion` | ✅ | The string `"1"`. |
| `apps` | ✅ | One entry for the site. (Several only when one release publishes several independent docs.) |
| `slug` | ✅ | `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–32 chars. Directory name in the archive **and** the public URL `/knowledge-base/{slug}/`. Unique across the whole knowledge base — prefix with the service name. |
| `name` | ✅ | 2–64 chars. Catalog card and masthead. |
| `description` | ✅ | 10–280 chars, one sentence. |
| `entryPoint` | ☐ | Landing page relative to the app directory. Default `index.html`. |
| `icon` | ☐ | `book-open` `cube` `chip` `chart-bar` `shield` `cog` `terminal` `globe` `layers` `lightning-bolt` `document` `collection` `puzzle` `database`. Default `book-open`. |
| `tags` | ☐ | ≤ 5 strings, ≤ 32 chars each. |
| `pages` | ☐ | The authoritative route list when present: `title` (1–128), `path` relative to the app dir (must exist in the build), integer `order` ≥ 0, optional `section` (≤ 64). |

`pages` is optional but worth writing when the generator already knows its navigation:
the knowledge base then uses your titles and your order. Omit it entirely rather than
half-fill it — absent, the knowledge base crawls every HTML file and derives titles from
the documents. If the generator can emit the list at build time (the mkdocs example
refreshes `pages` from frontmatter), that is better than a hand-maintained one, but it is
a change to the *existing* build, not a new script.

Unknown fields are ignored, not rejected — a typo in an optional field name silently does
nothing. Check the spelling against the table.

## C. The workflow

Start from `examples/packaged.publish-docs.yml` and write `.github/workflows/publish-docs.yml`:

```yaml
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

Change only the build step and, if needed, the two inputs:

- The `run:` line is the repo's own headless build. For a Python generator that is
  `actions/setup-python` plus `pip install -r requirements.txt && mkdocs build -f mkdocs-headless.yml`.
- `dist` is the directory the build writes. When the manifest declares **one** app it is
  that app's directory itself — do not create a `dist/<slug>/` nesting. When it declares
  several, `dist` holds one subdirectory per slug.
- `manifest` only if the file is not `kb-docs.json` at the root. It should be.

`notify-repo`/`notify-token` and the `npm-registry`/`node-mirror` inputs exist for
deployments that rebuild on publish and for private-network runners. Add them only when
the user's situation calls for it; see `contract/DEPLOYMENT.md`.

## What the action will check, in order

1. `kb-docs.json` exists, is valid JSON, satisfies `contract/kb-docs.schema.json`.
2. For every app: `dist/<entryPoint>` exists; every `pages[].path` exists; the output has HTML.
3. Every HTML file: `data-kb-headless="true"`, no `<base>`, no root-relative URLs.
4. Pack, upload to the release (replacing an existing `kb-docs.tar.gz`), optional notify.

All problems in a step are reported together, naming the file and the fix. If the first
run fails, the message is in `troubleshooting.md`.

## Then

- The user publishes a release; `kb-docs.tar.gz` appears among its assets.
- The user opens a PR to the deployment repo's `apps.json` adding
  `{ "repo": "owner/name", "version": "latest" }`. Nothing else — display fields come
  from the manifest.
