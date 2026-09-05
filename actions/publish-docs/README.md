# `publish-docs` action

Takes a repository's **already-built** headless documentation site, checks it
against the knowledge base contract, packs it as `kb-docs.tar.gz` and attaches it
to a GitHub Release.

```yaml
- uses: actions/checkout@v4
- run: npm ci && npm run build -- --headless    # whatever your generator is
- uses: AbsaOSS/knowledge-base/actions/publish-docs@v1
  with:
    manifest: kb-docs.json
    dist: dist
```

The action never builds your site. Doc repos use mkdocs, Starlight, Jekyll and
hand-rolled scripts; the contract is about the output, not the toolchain.

**Full documentation — the artifact layout, the manifest and its schema —
lives in [`contract/ARTIFACT.md`](../../contract/ARTIFACT.md).** The HTML rules
it checks are [`contract/HEADLESS_RULES.md`](../../contract/HEADLESS_RULES.md).

If your docs are a markdown file or two rather than a site, you want
[`publish-single-page-docs`](../publish-single-page-docs) instead: it renders the
markdown for you and needs no manifest at all.

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `manifest` | ☐ | `kb-docs.json` | Your manifest, relative to the workspace |
| `dist` | ☐ | `dist` | The built headless output |
| `release-tag` | ☐ | the triggering release, else the repo's latest | Release to attach the artifact to |
| `github-token` | ☐ | `${{ github.token }}` | Needs `contents: write` |
| `notify-repo` | ☐ | — | `owner/name` of a deployment repo to notify on publish |
| `notify-token` | ☐ | — | Token with `contents: write` on `notify-repo` only |

`dist` is the app's own directory when the manifest declares **one** app — a repo
publishing a single site should not have to invent a subdirectory named after its
own slug. When the manifest declares several, `dist` holds one subdirectory per
slug.

## Outputs

| Output | Description |
|---|---|
| `slugs` | Comma-separated list of published slugs |
| `count` | Number of apps in the artifact |
| `artifact` | Absolute path of the packed `kb-docs.tar.gz` |
| `release-tag` | Tag the artifact was uploaded to |

## What it checks

Before packing anything, and reporting **every** problem at once:

- the manifest validates against [`contract/kb-docs.schema.json`](../../contract/kb-docs.schema.json)
- every declared app has built output, and its `entryPoint` exists
- every `pages` entry points at a file that was actually built
- every HTML file carries `data-kb-headless="true"`
- no `<base>` element, and no root-relative `href`/`src`/`action`/`poster`

Inline `<script>` blocks are a **warning**, not a failure: the knowledge base
hoists them into files so it can serve `script-src 'self'`. Shipping them as
files instead keeps that under your control.

The schema is read from the action's own checkout, so it always matches the ref
you pinned and a publish never depends on a network fetch.

## Prerequisite: a release must exist

The action attaches to an existing release — it never creates one. Trigger on
`release: published` and it is guaranteed to be there, or pass `release-tag`
explicitly.

## Runner requirements

The action assumes nothing about the runner image, so it runs the same on
GitHub-hosted and self-hosted runners:

- **Node** comes from `actions/setup-node`; nothing needs to be preinstalled.
- **The release upload and the notify** go through `actions/github-script`,
  which ships its own runtime and an authenticated Octokit client. The `gh` CLI
  is **not** required (#85). Uploads go to the release's own `upload_url`, so
  GitHub Enterprise hosts work without configuration.
- **`bash`** is needed for the two one-line `run:` steps (`npm ci` and the
  entry point). Every GitHub-hosted image and Git for Windows provide it.
- **Network**: the GitHub API of the instance the workflow runs on, and the npm
  registry for `npm ci`. Nothing else is fetched.

The runner must be new enough for Node 24 actions (`actions/runner` ≥ 2.327.1),
which `actions/setup-node@v7` already requires.

## Notifying a deployment

Set `notify-repo` and `notify-token` to fire a `kb-docs-published`
`repository_dispatch` after a successful upload, so a deployment repository
rebuilds without waiting for its schedule. `repository_dispatch` needs
`contents: write` on the **target** repo, which the default `github.token`
cannot do — mint a token scoped to that repository and nothing else.

A failed notify never fails the publish: the artifact is already on the release,
and the deployment's scheduled build will pick it up.

## Versioning

Pin `@v1`. A breaking contract change ships as `@v2` alongside a `kbVersion`
bump, so a pinned major keeps publishing until you choose to move.

## Working on it

```bash
cd actions
npm ci
npm run selftest          # both actions
npm run selftest:docs     # this one
```

The self-test builds sample sites in a temp directory and runs the real entry
point over them. It asserts the error messages as much as the happy path: this
action is the whole interface a docs repo has with the contract, so a message
that does not say which file is wrong costs somebody a CI round trip.

## Layout

| Path | Role |
|---|---|
| `action.yml` | Composite action: setup-node → `npm ci` → verify + pack → upload (`github-script`) → notify (`github-script`) |
| `src/index.js` | Entry point. Reads inputs from env, writes step outputs. |
| `src/selftest.js` | The self-test described above. |

Shared with the other action in [`actions/lib/`](../lib): manifest validation,
HTML verification, deterministic packing, the runner plumbing, and
`release.cjs` — the release upload and the notify, run by `github-script`
against its Octokit client. Dependencies are pinned once in
[`actions/package.json`](../package.json).
