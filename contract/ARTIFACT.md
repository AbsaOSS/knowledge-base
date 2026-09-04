# The knowledge base artifact

This is the normative description of what a docs repo publishes and what the
knowledge base consumes. [`HEADLESS_RULES.md`](./HEADLESS_RULES.md) and
[`SINGLE_PAGE.md`](./SINGLE_PAGE.md) describe two ways of *producing* one; both
produce exactly what is described here.

---

## One asset, one manifest

A docs repo attaches a single asset to its GitHub Release:

```
kb-docs.tar.gz
├─ kb-docs.json
├─ <slug-a>/
│  ├─ index.html          ← entryPoint
│  └─ assets/…
└─ <slug-b>/              ← only a bundle publishing several apps has more than one
   └─ …
```

The name is `kb-docs.tar.gz`, not `dist.tar.gz`: a docs bundle is not the repo's
own distribution package, and a release usually carries both.

**Every app the knowledge base serves is a directory in this archive plus an
entry in `kb-docs.json`.** A repo publishing one documentation site is a manifest
listing one app. A repo publishing a set of standalone markdown docs is a
manifest listing several. Nothing downstream distinguishes the two cases.

---

## `kb-docs.json`

At the archive root. UTF-8, no BOM.

```jsonc
{
  "kbVersion": "1",
  "apps": [
    {
      "slug": "user-guide",
      "name": "Knowledge Base User Guide",
      "description": "Everything you need to publish your own documentation.",
      "icon": "book-open",
      "tags": ["guide", "getting-started"],
      "entryPoint": "index.html",
      "pages": [
        { "title": "Overview",   "path": "index.html",                 "order": 1 },
        { "title": "Publishing", "path": "docs/publishing/index.html", "order": 2, "section": "Guide" }
      ]
    }
  ]
}
```

### Top level

| Field | Required | Rules |
|---|---|---|
| `kbVersion` | ✅ | Contract version, as a **string**. `"1"` today. A knowledge base that does not understand the value fails the build and says so. |
| `apps` | ✅ | Non-empty array. One entry per app. |

### Each app

| Field | Required | Rules |
|---|---|---|
| `slug` | ✅ | `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–32 characters. Names the directory in the archive **and** the public URL `/knowledge-base/{slug}/`. Must be unique across the entire knowledge base, not just within your bundle — prefix it with your service name. |
| `name` | ✅ | 2–64 characters. Shown on the catalog card and in the masthead. |
| `description` | ✅ | 10–280 characters. One sentence, shown on the catalog card. |
| `entryPoint` | ☐ | Path to the landing page, relative to `<slug>/`. Default `index.html`. |
| `icon` | ☐ | One of the [icon set](#icon-set). Default `book-open`. |
| `tags` | ☐ | Up to 5 strings, ≤ 32 characters each. Shown as pills on the card. |
| `pages` | ☐ | Navigation manifest — see below. Absent means the knowledge base crawls `<slug>/` for HTML. |

### `pages`

When present, this is the **authoritative** route list for the app: the knowledge
base serves exactly these and does not crawl. Use it to control titles and
ordering; omit it and every HTML file under `<slug>/` becomes a route with a
title derived from the document.

| Field | Required | Rules |
|---|---|---|
| `title` | ✅ | 1–128 characters. Shown in navigation. |
| `path` | ✅ | Path to the HTML file, relative to `<slug>/`. Must exist in the archive. |
| `order` | ✅ | Integer ≥ 0. Lower sorts higher. |
| `section` | ☐ | ≤ 64 characters. Group heading to display above this page. |

### Icon set

`book-open`, `cube`, `chip`, `chart-bar`, `shield`, `cog`, `terminal`, `globe`,
`layers`, `lightning-bolt`, `document`, `collection`, `puzzle`, `database`.

An unrecognised icon falls back to `book-open` rather than failing the build —
an icon is not worth breaking a deployment over.

### Versioning

`kbVersion` is a string so it can become `"1.1"` or `"2"` without changing type.

- **Additive changes** — a new optional field — do not change `kbVersion`. A
  knowledge base ignores manifest fields it does not recognise, so a newer
  publisher never breaks an older knowledge base.
- **Breaking changes** bump the major and ship as a new major tag of the
  publishing actions. The two move together.

Because unknown fields are ignored rather than rejected, do not rely on the
knowledge base to catch a typo in an optional field name. Validate against
[`kb-docs.schema.json`](./kb-docs.schema.json); the publishing actions do this
for you.

---

## Archive rules

The archive is untrusted input: it comes from another repository and is unpacked
into a directory this deployment then serves. Extraction is refused outright if
any member:

- is an absolute path, or carries a drive letter;
- contains a `..` segment;
- is a symbolic or hard link;
- is anything other than `kb-docs.json` or a path under a `<slug>/` directory
  named in the manifest.

The last rule is what keeps a stray file from becoming a route. A member under a
directory that the manifest does not declare is ignored with a warning, not
served.

`kb-docs.json` may also sit under a single `dist/` wrapper; the knowledge base
accepts that, because it is a detail of the packing step rather than something
the publishing repo chooses deliberately. Nothing else is unwrapped.

### Size

Every registered artifact is downloaded on every deployment build, so size is a
shared cost rather than a private one.

| | |
|---|---|
| Target | ≤ 20 MB per artifact |
| Warned | > 20 MB — the build logs the size and names the app |
| Refused | > 100 MB, which is also GitHub's per-asset release limit |

The usual cause of a large artifact is uncompressed images or a vendored
toolchain that the built site does not need at runtime. A docs bundle should
carry rendered HTML, CSS, fonts and images, and nothing else.

---

## What the HTML must look like

Identical for both producers, and specified in
[`HEADLESS_RULES.md`](./HEADLESS_RULES.md):

- `data-kb-headless="true"` on `<html>`
- no `<base>` element; every asset path relative
- no site-level fixed header, no theme toggle, light only
- the design tokens in [`STYLE_GUIDE.md`](./STYLE_GUIDE.md)

Inline `<script>` is permitted but discouraged: the deployment serves
`script-src 'self'`, so the knowledge base hoists inline bodies into files at
build time. A doc that needs inline scripting to render will not render.

---

## Registering

Once your release carries `kb-docs.tar.gz`, open a PR against
`AbsaOSS/knowledge-base` adding one entry to `apps.json`:

```json
{ "repo": "AbsaOSS/my-service", "version": "latest" }
```

That is the whole entry. No slug, no name, no description, no icon, no tags:
all of it is read from your manifest, so adding, renaming or removing a doc
later never touches the knowledge base repository again. `version` accepts
`latest` (the default) or a pinned tag such as `v1.4.0`.
