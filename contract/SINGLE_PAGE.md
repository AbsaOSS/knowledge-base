# Single-page documentation

The zero-config way into the knowledge base. Your repo has one or more markdown
files; you add **one workflow file and nothing else**. No mkdocs, no theme, no
manifest to write, no build script, no headless flag — the action derives the
manifest from the workflow inputs below.

The reusable action renders your markdown into headless HTML, packs it as
`kb-docs.tar.gz`, and attaches it to your latest GitHub Release. The knowledge base
picks it up on its next build and gives every doc its own catalog card and URL.

> Choosing between the three onboarding types:
>
> | Type | Use when | Cost to your repo |
> |---|---|---|
> | **single-page** | You have markdown files, not a docs *site* | one workflow file |
> | *default* (packaged) | You have a real static docs site (mkdocs, Starlight…) | headless build + `kb-docs.json` + release workflow — see [HEADLESS_RULES.md](./HEADLESS_RULES.md) |
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
      - uses: AbsaOSS/knowledge-base/actions/publish-single-page-docs@master
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
| `release-tag` | ☐ | the triggering release, else the repo's latest | Release to attach `kb-docs.tar.gz` to |
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
| `artifact` | Absolute path of the packed `kb-docs.tar.gz` |
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
  "version": "latest"
}
```

Note what is *not* there: no slug, no name, no description, no icon, no tags, and
no type. All of it is read from your manifest, so adding, renaming or removing a
doc later never touches the knowledge base repo again — publish a new release and
the next knowledge-base build picks it up. It is also the same entry a packaged
docs site gets: the registry records where an artifact comes from, nothing more.

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

Mermaid is vendored into the artifact rather than loaded from a CDN: knowledge base
pages are re-hosted inside a web fragment behind a strict CSP, so every asset a
doc needs must live in its own artifact. If the script never runs, the diagram
source stays visible rather than disappearing.

If your markdown has no top-level `#` heading, the action synthesises one from
`title` plus `description`. If it has one, nothing is injected.

### Raw HTML: what survives

Markdown may contain raw HTML, as GitHub-flavoured markdown allows. It is put
through an **allowlist** before it is packed into the artifact, because your
rendered doc is re-hosted on the knowledge base's own origin alongside every
other team's docs — anything that executes there executes against all of them.

**Kept:** the structural and inline elements the doc stylesheet renders —
headings, paragraphs, lists, tables, `details`/`summary`, `figure`, `blockquote`,
`pre`/`code`, `img`, `a`, `label`, emphasis and the rest of the usual inline set,
along with their `class` and `id` attributes.

**Dropped, with the inner text kept where there is any:**

| Removed | Why |
|---|---|
| `<script>` | Would run on the knowledge base origin |
| `on*` attributes (`onclick`, `onerror`, …) | Same |
| `<style>` and `style="…"` | CSS can exfiltrate via `url()` and can cover the knowledge base masthead |
| `<iframe>`, `<object>`, `<embed>` | Arbitrary embedded documents |
| `<form>` and form controls (except task-list checkboxes) | Credential-phishing surface |
| `javascript:` and `data:` URLs | Script execution by another name |

If you need something that is currently dropped and it is genuinely inert, open
an issue — the allowlist lives in `actions/publish-single-page-docs/src/sanitize.js`
and is asserted by the action's self-test.

There is no way to opt out. A doc that depends on inline scripting is not a
single-page doc; package it as a full static site instead
(see [HEADLESS_RULES.md](./HEADLESS_RULES.md)).

### Artifact layout

`kb-docs.tar.gz` unpacks to a `kb-docs.json` manifest plus one directory per doc:

```
kb-docs.json
my-service/
  index.html
  assets/doc.css
  assets/mermaid.min.js     ← only when that doc uses mermaid
  assets/mermaid-init.js    ← ditto; kept out of the HTML so the knowledge base
                              can serve script-src 'self'
my-service-releases/
  index.html
  assets/doc.css
```

### `kb-docs.json`

```json
{
  "kbVersion": "1",
  "apps": [
    {
      "slug": "my-service",
      "name": "Service Overview",
      "description": "What the service does and how to use it.",
      "icon": "cube",
      "tags": ["platform", "api"],
      "entryPoint": "index.html"
    }
  ]
}
```

Your `title` becomes the app's `name`; everything else carries over as you wrote
it. One entry per doc.

This is the same manifest a packaged documentation site publishes, specified in
[`ARTIFACT.md`](./ARTIFACT.md) and validated against
[`kb-docs.schema.json`](./kb-docs.schema.json). There is no separate single-page
format: a set of markdown docs is a manifest listing several apps, a docs site is
a manifest listing one, and the knowledge base reads both the same way.

### Generated HTML

Each `index.html` satisfies [HEADLESS_RULES.md](./HEADLESS_RULES.md):

- `data-kb-headless="true"` on `<html>`
- no `<base>` tag, every asset path relative
- no site-level `<header>`, no sidebar, no theme toggle
- light only — no dark palette, no `localStorage` theme bootstrap

The body is a single `<article class="kb-doc">`. All prose styling lives in
`assets/doc.css`, scoped to `.kb-doc`, so nothing leaks into the masthead or into
a host application when the page is embedded as a web fragment.

---

## How the knowledge base renders it

The knowledge base expands one `single-page` registry entry into one app per doc,
then renders each in its own reading column:

```html
<main id="content" class="kb-single-page">
  <article class="kb-doc"> … </article>
</main>
```

`.kb-single-page` (in `src/styles/knowledge-base.css`) owns the measure — ~800px of
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
| `the release artifact has no kb-docs.json at its root` | The release's `kb-docs.tar.gz` was not produced by this action. |

---

## Checklist

- [ ] `.github/workflows/publish-docs.yml` added, with `permissions: contents: write`
- [ ] Every `slug` is lowercase kebab-case and prefixed with your service name
- [ ] Each `description` is 10–280 characters
- [ ] The workflow ran and `kb-docs.tar.gz` is attached to the release
- [ ] A PR adds the `{ "repo": … }` entry to `apps.json`
