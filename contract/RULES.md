# Contract rules

Every requirement a published docs site is checked against, by ID. The other contract
pages explain the model — [`ARTIFACT.md`](./ARTIFACT.md) the archive and manifest,
[`HEADLESS_RULES.md`](./HEADLESS_RULES.md) the headless build — and this page is the
list a check reports against: each finding names one of these IDs.

**Severity** is what the `publish-docs` action does with a finding:

- **error** — the publish stops, with every error listed at once.
- **warning** — the finding is annotated on the workflow run, and the publish goes ahead.
  The knowledge base either repairs it when it re-hosts the page, or it only hurts the
  page that carries it. Fix it anyway: a repaired page is not the page you wrote.

New rules are introduced as warnings. A warning only becomes an error in a new major
version of the actions (`@v2`), so a repo pinned to `@v1` never starts failing on a rule
it has not seen before.

## Running the checks

The `publish-docs` action runs them before it packs anything. On a pull request, the
[`check-docs`](../actions/check-docs) action runs the same checks without releasing
anything: add it next to the publish workflow, with the same build step and `dist`.
Locally — or while fixing a repo — use the same code from a checkout of this repository:

```bash
git clone --depth 1 https://github.com/AbsaOSS/knowledge-base.git /tmp/knowledge-base
npm ci --omit=dev --prefix /tmp/knowledge-base/actions
node /tmp/knowledge-base/actions/lib/check-cli.js --manifest kb-docs.json --dist dist
```

`--json` prints the findings as a JSON array (`id`, `severity`, `where`, `message`);
`--strict` exits non-zero on warnings as well as errors.

The knowledge base build runs the same checks again on every artifact it installs and
logs the findings. A strict (production) build refuses an artifact with an error finding
— see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

## Index

| ID | Severity | Rule |
|---|---|---|
| [KB-MAN-001](#kb-man-001--kb-docsjson-exists-and-satisfies-the-schema) | error | kb-docs.json exists and satisfies the schema |
| [KB-ART-001](#kb-art-001--the-entry-point-exists-in-the-built-output) | error | The entry point exists in the built output |
| [KB-ART-002](#kb-art-002--every-pages-entry-exists-in-the-built-output) | error | Every pages entry exists in the built output |
| [KB-ART-003](#kb-art-003--each-app-contains-html) | error | Each app contains HTML |
| [KB-ART-004](#kb-art-004--the-artifact-is-at-most-20-mb) | warning | The artifact is at most 20 MB |
| [KB-ART-005](#kb-art-005--the-artifact-is-at-most-100-mb) | error | The artifact is at most 100 MB |
| [KB-HTML-001](#kb-html-001--every-page-is-marked-headless) | error | Every page is marked headless |
| [KB-HTML-002](#kb-html-002--no-base-element) | error | No `<base>` element |
| [KB-HTML-003](#kb-html-003--no-root-relative-urls) | error | No root-relative URLs |
| [KB-HTML-004](#kb-html-004--no-inline-script-blocks) | warning | No inline `<script>` blocks |
| [KB-HTML-005](#kb-html-005--no-inline-event-handler-attributes) | warning | No inline event handler attributes |
| [KB-HTML-006](#kb-html-006--no-javascript-urls) | warning | No `javascript:` URLs |
| [KB-HTML-007](#kb-html-007--no-site-level-header) | warning | No site-level `<header>` |
| [KB-HTML-008](#kb-html-008--no-links-to-non-html-files-in-the-app) | warning | No links to non-HTML files in the app |
| [KB-CSS-001](#kb-css-001--no-important-declarations) | warning | No `!important` declarations |
| [KB-THEME-001](#kb-theme-001--no-dark-mode) | warning | No dark mode |
| [KB-CSP-001](#kb-csp-001--no-scripts-stylesheets-or-fonts-from-another-origin) | warning | No scripts, stylesheets or fonts from another origin |
| [KB-JS-001](#kb-js-001--no-fetches-of-page-relative-urls) | warning | No fetches of page-relative URLs |

---

## Manifest and artifact

### KB-MAN-001 — kb-docs.json exists and satisfies the schema

**Severity:** error

The manifest must exist where the action's `manifest` input points, parse as JSON and
validate against [`kb-docs.schema.json`](./kb-docs.schema.json). Every schema violation
is reported at once, each naming the field. Fields are specified in
[`ARTIFACT.md`](./ARTIFACT.md).

### KB-ART-001 — The entry point exists in the built output

**Severity:** error

Each app's `entryPoint` (default `index.html`) must exist in that app's built directory.
Usually the action's `dist` input points at the wrong directory, or — with several apps —
`dist` does not hold one subdirectory per slug.

### KB-ART-002 — Every pages entry exists in the built output

**Severity:** error

When an app lists `pages`, every `path` must exist. The list is the authoritative route
table; a missing page is a broken navigation entry.

### KB-ART-003 — Each app contains HTML

**Severity:** error

An app directory with no `.html` file at all has nothing to serve.

### KB-ART-004 — The artifact is at most 20 MB

**Severity:** warning

Every registered artifact is downloaded on every knowledge base build. Over 20 MB the
action warns; see the size table in [`ARTIFACT.md`](./ARTIFACT.md). Uncompressed images
and vendored toolchains are the usual cause.

### KB-ART-005 — The artifact is at most 100 MB

**Severity:** error

Over 100 MB the action refuses to publish. It is also GitHub's per-asset release limit.

## HTML

### KB-HTML-001 — Every page is marked headless

**Severity:** error

`<html>` must carry `data-kb-headless="true"`, which is what a headless build emits (see
[`HEADLESS_RULES.md`](./HEADLESS_RULES.md)). The pre-v1 spelling `data-mp-headless` is
reported by name: republish with a current action.

### KB-HTML-002 — No `<base>` element

**Severity:** error

A `<base>` re-resolves every relative URL on the page against a location of its own,
which stops being right the moment the page is re-hosted under `/knowledge-base/{slug}/`.

### KB-HTML-003 — No root-relative URLs

**Severity:** error

`href`, `src`, `action`, `formaction` and `poster` values must be relative (`guide/`,
`../img/x.png`), not root-relative (`/guide/`). The app is served from
`/knowledge-base/{slug}/`; the knowledge base rebases a root-relative URL onto that app
root, which is only what you meant if your site was built for the root of a domain.
Relative paths mean the same thing everywhere. `/favicon…` and protocol-relative
`//host/…` URLs are not checked.

### KB-HTML-004 — No inline `<script>` blocks

**Severity:** warning

The knowledge base serves `script-src 'self'`, so it moves every executable inline script
into a file of its own when it re-hosts the page. Ship scripts as files to keep control
of what runs. JSON and other data blocks (`type="application/ld+json"` and the like) are
not scripts and are not reported.

### KB-HTML-005 — No inline event handler attributes

**Severity:** warning

`onclick="…"` and every other `on*` attribute is blocked by `script-src 'self'`: the
handler never runs. Attach listeners from a script file.

### KB-HTML-006 — No `javascript:` URLs

**Severity:** warning

Blocked by `script-src 'self'` for the same reason as KB-HTML-005. Use a `<button>` with
a listener from a script file.

### KB-HTML-007 — No site-level `<header>`

**Severity:** warning

The knowledge base masthead is the only site-level header. A `<header>` directly inside
`<body>` is the site bar a headless build must leave out (see
[`HEADLESS_RULES.md`](./HEADLESS_RULES.md)). A `<header>` inside your content — an
article or section header — is fine and is not reported.

### KB-HTML-008 — No links to non-HTML files in the app

**Severity:** warning

Embedded in a host application, the knowledge base's URLs are routed through the host.
A request for a page loads the page; a request the browser makes *as a document* for
anything else — a PDF, a ZIP, an image opened from a link — reaches the host
application, which answers with its own page instead of the file. Link to an HTML page
that embeds or describes the file, or host downloads outside the docs. Links to other
origins are not reported.

## CSS

### KB-CSS-001 — No `!important` declarations

**Severity:** warning

Every sub-app stylesheet is wrapped in the `kb-app` cascade layer, below the knowledge
base's own rules, so a stylesheet that outlives its page cannot restyle the masthead or
the catalog. `!important` inverts layer order: an important declaration in a lower layer
beats a normal one in a higher layer. Raise specificity instead.

## Theme

### KB-THEME-001 — No dark mode

**Severity:** warning

The knowledge base is light only (see [`STYLE_GUIDE.md`](./STYLE_GUIDE.md)). It deletes
a theme bootstrap script and a `dark` class on `<html>` or `<body>` when it re-hosts the
page, so a headless build should not ship them.

## Content Security Policy

### KB-CSP-001 — No scripts, stylesheets or fonts from another origin

**Severity:** warning

The knowledge base serves `script-src 'self'`, `style-src 'self' 'unsafe-inline'` and
`font-src 'self' data:`. A `<script src>`, a stylesheet `<link>`, a preload of a script,
style or font, a CSS `@import` or an `@font-face` source on another origin is blocked.
Ship them with the site. Images from `https:` origins are allowed.

## JavaScript

### KB-JS-001 — No fetches of page-relative URLs

**Severity:** warning

Embedded, a page-relative URL is resolved against the **host** page, not against your
app: elements a script creates belong to the host document, and a host router may
strip the trailing slash from `/knowledge-base/{slug}/page/`, which moves every relative
URL one directory up. A literal relative URL passed to `fetch()` or
`XMLHttpRequest.open()` is reported. Resolve it against the script instead —
`new URL('data.json', import.meta.url)` in a module, or `document.currentScript.src` in
a classic script. This is a textual check: URLs assembled at runtime are not seen, and a
match inside a string or comment is reported anyway.
