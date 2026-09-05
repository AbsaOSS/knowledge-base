# Single-page path

One workflow file. The `publish-single-page-docs` action renders each markdown file to
headless HTML, writes the manifest from the inputs you give it, packs `kb-docs.tar.gz`
and attaches it to the release. Normative text: `contract/SINGLE_PAGE.md` in
`AbsaOSS/knowledge-base`.

## The one file

Start from `examples/single-page.publish-docs.yml` (it is the contract's own copy) and
write it to `.github/workflows/publish-docs.yml`:

```yaml
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
      - uses: AbsaOSS/knowledge-base/actions/publish-single-page-docs@v1
        with:
          docs: |
            - md: docs/overview.md
              title: Service Overview
              description: What the service does and how to use it.
              slug: my-service
```

Keep the trigger, the permission block and `actions/checkout` exactly as they are:
the action reads the markdown from the checkout and attaches to the release that fired
the workflow. `workflow_dispatch` stays so a maintainer can re-publish to the latest
release by hand.

If the repo already has a release workflow, adding this file is still the right call.
Appending a step to an existing job couples doc publishing to whatever that job does,
and the knowledge base only cares that the asset lands on the release.

## Deriving the `docs` list

One list entry per markdown file the user wants published. Fill each from the file
itself rather than inventing copy:

| Field | Take it from | Rules |
|---|---|---|
| `md` | the path, relative to the repo root | Must exist in the checkout. A README works. |
| `title` | the file's first `#` heading, or the file name in words | ≤ 128 characters. Shown on the catalog card and in the masthead. |
| `description` | the first paragraph, trimmed to one sentence | 10–280 characters. Not a heading, not a badge line. |
| `slug` | `<service>` or `<service>-<topic>` | `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–32 characters. Becomes `/knowledge-base/{slug}/` and must be unique across **every** repo in the knowledge base — the service prefix is what makes that true. |
| `icon` | the doc's nature | Optional. One of `book-open` `cube` `chip` `chart-bar` `shield` `cog` `terminal` `globe` `layers` `lightning-bolt` `document` `collection` `puzzle` `database`. Default `book-open`. |
| `tags` | the repo's domain | Optional. Up to 5 short strings. Reuse tags other docs in the org already use rather than coining new ones. |

Which files to include: the ones the user named. When they only said "our docs", take
the markdown under `docs/` plus the README if it is the actual overview, and list what
you left out so they can add it. Do not publish `CHANGELOG.md`, `CONTRIBUTING.md`,
`SECURITY.md`, licence files or templates unless asked — they are repo hygiene, not
documentation for a reader of the knowledge base.

Nothing about the markdown needs to change. If it has no `#` heading the action adds
one from `title` and `description`.

## What the renderer does to the markdown

GitHub-flavoured markdown via markdown-it: tables, task lists, footnotes, highlighted
fenced code, and ` ```mermaid ` blocks rendered from a vendored bundle. Raw HTML passes
an allowlist because the output is re-hosted on the knowledge base origin next to every
other team's docs:

- **Kept**: structural and inline elements, `details`/`summary`, `img`, `a`, `class`/`id`.
- **Dropped**: `<script>`, `on*` attributes, `<style>` and `style="…"`, `<iframe>`,
  `<object>`, `<embed>`, `<form>` and form controls, `javascript:`/`data:` URLs.

If a doc relies on any of the dropped items to make sense, warn the user before
publishing. There is no opt-out; a doc that needs scripting is a packaged site.

## Private-network runners

Only when the job runs on self-hosted runners that cannot reach `registry.npmjs.org`.
Add the inputs to the same step, nothing else:

```yaml
      - uses: AbsaOSS/knowledge-base/actions/publish-single-page-docs@v1
        with:
          npm-registry: https://artifactory.example.com/artifactory/api/npm/npm-remote/
          npm-token: ${{ secrets.ARTIFACTORY_TOKEN }}   # omit for anonymous reads
          docs: |
            …
```

`node-mirror` / `node-mirror-token` exist for runners that can reach neither github.com
release assets nor nodejs.org. Do not add any of these speculatively: on GitHub-hosted
runners the plain workflow is complete, and an unused input is one more thing a reviewer
has to ask about.

## Then

- The user publishes a release. `kb-docs.tar.gz` appears on it.
- The user opens a PR to the deployment repo's `apps.json`:
  `{ "repo": "owner/name", "version": "latest" }`. The knowledge base expands that one
  entry into one catalog card per doc, so renaming or adding docs later is a new release,
  not a registry change.
