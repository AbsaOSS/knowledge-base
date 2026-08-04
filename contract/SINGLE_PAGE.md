# Single-page documentation

The zero-config way into the knowledge base. Your repo has one or more markdown
files; you add **one workflow file and nothing else**. No mkdocs, no theme, no
`marketplace.json`, no build script, no headless flag.

The reusable action renders your markdown into headless HTML, packs it as
`dist.tar.gz`, and attaches it to your latest GitHub Release. The knowledge base
picks it up on its next build and gives every doc its own catalog card and URL.

> Choosing between the three onboarding types:
>
> | Type | Use when | Cost to your repo |
> |---|---|---|
> | **single-page** | You have markdown files, not a docs *site* | one workflow file |
> | *default* (packaged) | You have a real static docs site (mkdocs, Starlight…) | headless build + `marketplace.json` + release workflow — see [HEADLESS_RULES.md](./HEADLESS_RULES.md) |
> | *iframe* | Your docs are already hosted elsewhere and can't be packaged yet | an `apps.json` entry — explicit stopgap, see [HEADLESS_RULES.md](./HEADLESS_RULES.md) |

---

## 1. Add the workflow

```yaml
# .github/workflows/publish-docs.yml in your docs repo
name: Publish docs

on:
  release:
    types: [published]
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # required — the action uploads a release asset
    steps:
      - uses: actions/checkout@v4
      - uses: AbsaOSS/knowledge-base/actions/publish-docs@master
        with:
          docs: |
            - md: docs/overview.md
              title: Service Overview
              description: What the service does and how to use it.
              slug: my-service
```

That is the entire onboarding on your side. Multiple docs go in the same list:

```yaml
          docs: |
            - md: docs/overview.md
              title: Service Overview
              description: What the service does and how to use it.
              slug: my-service
              icon: cube
              tags: [platform, api]
            - md: RELEASING.md
              title: Release Process
              description: How a release is cut and published.
              slug: my-service-releases
              icon: cog
```

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `docs` | ✅ | — | YAML (or JSON) **list** of doc definitions — see below |
| `release-tag` | ☐ | the triggering release, else the repo's latest | Release to attach `dist.tar.gz` to |
| `github-token` | ☐ | `${{ github.token }}` | Needs `contents: write` |

### Each doc definition

| Field | Required | Rules |
|---|---|---|
| `md` | ✅ | Path to the markdown file, relative to the repo root. Must exist in the checkout. |
| `title` | ✅ | Shown on the catalog card and in the masthead. ≤ 128 characters. |
| `description` | ✅ | One sentence for the catalog card. 10–280 characters. |
| `slug` | ✅ | Lowercase kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`), 2–32 characters. **Becomes the public URL** `/knowledge-base/{slug}/` and must be unique across the *whole* knowledge base, so prefix it with your service name. |
| `icon` | ☐ | One of `book-open`, `cube`, `chip`, `chart-bar`, `shield`, `cog`, `terminal`, `globe`, `layers`, `lightning-bolt`, `document`, `collection`, `puzzle`, `database`. Default `book-open`. |
| `tags` | ☐ | Up to 5 short strings, shown as pills on the card. |

Validation runs before anything is rendered and reports **every** problem at once,
naming the entry and the fix.

### Outputs

| Output | Description |
|---|---|
| `slugs` | Comma-separated list of published slugs |
| `count` | Number of docs in the bundle |
| `artifact` | Absolute path of the packed `dist.tar.gz` |
| `release-tag` | Tag the bundle was uploaded to |

### Prerequisite: a release must exist

The action attaches the bundle to an existing release — it never creates one. If
the repo has no releases at all the run fails with a message saying so. Trigger
on `release: published` (as above) and the release is guaranteed to be there.

---

## 2. Ask for the registry entry

Open a PR against `AbsaOSS/knowledge-base` adding **one** entry to `apps.json`:

```json
{
  "repo": "AbsaOSS/my-service",
  "type": "single-page",
  "version": "latest"
}
```

Note what is *not* there: no slug, no name, no description, no icon, no tags. All
of it is discovered from the bundle, so adding, renaming or removing a doc later
never touches the knowledge base repo again — publish a new release and the next
knowledge-base build picks it up.

`version` accepts `latest` (default) or a pinned tag such as `v1.4.0`.

---

## What the action produces

### Markdown support

GitHub-flavoured markdown, rendered by `markdown-it`:

- tables, task lists, strikethrough, footnotes
- bare URLs autolinked; external links get `target="_blank" rel="noopener noreferrer"`
- heading anchors on `h1`–`h4`
- syntax-highlighted fenced code (highlight.js) on the slate code surface from
  [STYLE_GUIDE.md](./STYLE_GUIDE.md)
- ` ```mermaid ` blocks, rendered client-side from a **vendored** mermaid bundle

Mermaid is vendored into the artifact rather than loaded from a CDN: marketplace
pages are re-hosted inside a web fragment behind a strict CSP, so every asset a
doc needs must live in its own artifact. If the script never runs, the diagram
source stays visible rather than disappearing.

If your markdown has no top-level `#` heading, the action synthesises one from
`title` plus `description`. If it has one, nothing is injected.

### Artifact layout

`dist.tar.gz` unpacks to a `bundle.json` manifest plus one directory per doc:

```
bundle.json
my-service/
  index.html
  assets/doc.css
  assets/mermaid.min.js     ← only when that doc uses mermaid
my-service-releases/
  index.html
  assets/doc.css
```

### `bundle.json`

```json
{
  "marketplaceVersion": "1",
  "type": "single-page",
  "docs": [
    {
      "slug": "my-service",
      "title": "Service Overview",
      "description": "What the service does and how to use it.",
      "icon": "cube",
      "tags": ["platform", "api"],
      "entryPoint": "index.html"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `marketplaceVersion` | ✅ | Contract version. Must be `"1"`. |
| `type` | ✅ | Must be `"single-page"`. |
| `docs` | ✅ | Non-empty list. Each doc needs `slug`, `title` and `description`; `icon`, `tags` and `entryPoint` (default `index.html`) are optional. |

`bundle.json` is the single-page counterpart of `marketplace.json` — one manifest
describing a *set* of apps rather than one app. Packaged doc sites keep using
`marketplace.json` and [`schema.json`](./schema.json) unchanged.

### Generated HTML

Each `index.html` satisfies [HEADLESS_RULES.md](./HEADLESS_RULES.md):

- `data-mp-headless="true"` on `<html>`
- no `<base>` tag, every asset path relative
- no site-level `<header>`, no sidebar, no theme toggle
- light only — no dark palette, no `localStorage` theme bootstrap

The body is a single `<article class="mp-doc">`. All prose styling lives in
`assets/doc.css`, scoped to `.mp-doc`, so nothing leaks into the masthead or into
a host application when the page is embedded as a web fragment.

---

## How the knowledge base renders it

The marketplace expands one `single-page` registry entry into one app per doc,
then renders each in its own reading column:

```html
<main id="content" class="mp-single-page">
  <article class="mp-doc"> … </article>
</main>
```

`.mp-single-page` (in `src/styles/marketplace.css`) owns the measure — ~800px of
content, centred, with generous vertical rhythm — so every single-page doc reads
identically regardless of which repo published it. The persistent masthead is the
only navigation; there is no sidebar and no in-app chrome.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `has no GitHub Release to attach the docs bundle to` | The repo has no releases. Create one, or pass `release-tag`. |
| `md "…" does not exist in the repository` | Wrong path, or `actions/checkout` is missing from the job. |
| `slug "…" is invalid` | Slugs are lowercase kebab-case only — no underscores, capitals or spaces. |
| `Duplicate app slug "…"` (knowledge-base build) | Another registered app already owns that URL prefix. Rename yours and republish. |
| `the release artifact has no bundle.json at its root` | The release's `dist.tar.gz` was not produced by this action. |

---

## Checklist

- [ ] `.github/workflows/publish-docs.yml` added, with `permissions: contents: write`
- [ ] Every `slug` is lowercase kebab-case and prefixed with your service name
- [ ] Each `description` is 10–280 characters
- [ ] The workflow ran and `dist.tar.gz` is attached to the release
- [ ] A PR adds the `{ "repo": …, "type": "single-page" }` entry to `apps.json`
