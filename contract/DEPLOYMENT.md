# Deploying the knowledge base

Deployment is **not** part of this repository, and that is deliberate. A private
deployment repository owns the production registry, the cloud account and the
schedule. This repository is the build tool it calls.

This document is the definition that private repository is built from. The
copy-paste skeleton is in [`examples/deployment-repo/`](../examples/deployment-repo).

---

## What lives where

| | Knowledge base (public) | Deployment repo (private) |
|---|---|---|
| The build | ✅ `scripts/`, `src/`, `Dockerfile`, `nginx.conf` | — |
| The publishing actions | ✅ `actions/` | — |
| The contract | ✅ `contract/` | — |
| **Which docs are published** | ❌ its `apps.json` is a CI fixture | ✅ `apps.json` |
| **Which versions** | ❌ | ✅ `apps.json` |
| Cloud account, image registry, schedule | ❌ | ✅ |

The `apps.json` committed in this repository registers a vendored test fixture
and an optional sibling checkout. It exists so CI and `npm run preview` are
hermetic. **It is never the production registry**, and a strict build rejects it
outright.

---

## The deployment repository

```
deployment-repo/
├─ apps.json                       # the production registry
└─ .github/workflows/
   ├─ build.yml                    # calls the reusable workflow below
   └─ deploy.yml                   # your cloud's deploy step (out of scope here)
```

### `apps.json`

Source-only entries, as specified in [`ARTIFACT.md`](./ARTIFACT.md):

```json
[
  { "repo": "AbsaOSS/my-service-docs", "version": "latest" },
  { "repo": "AbsaOSS/platform-docs",   "version": "v2.1.0" }
]
```

A strict build enforces what a production registry may contain:

| Rejected | Why |
|---|---|
| `prebuilt` | A path on somebody's disk is not a reproducible deployment |
| `localPath` | Same |
| `optional` | Permission to ship without an app nobody noticed was missing |
| an entry that produces no apps | A registered artifact that publishes nothing is a broken deploy |
| an empty registry | A knowledge base with no docs is not a successful build |

`iframe` entries are still allowed — they are an explicit, documented stopgap
(issue #10) and carry `"temporary": true`.

**Pinning.** `"version": "latest"` follows the docs repo, which is usually what
teams want. Pin a tag for anything that must not move without review; rolling
back then means changing one line and rebuilding.

### `build.yml`

```yaml
name: Build

on:
  push:
    branches: [main]
    paths: [apps.json]              # the registry changed
  repository_dispatch:
    types: [kb-docs-published]      # a docs repo published (see below)
  schedule:
    - cron: '0 3 * * *'             # safety net for anything that did not notify
  workflow_dispatch:

concurrency:
  group: kb-build                   # a burst of publishes collapses into one build
  cancel-in-progress: true

permissions:
  contents: read
  packages: write
  id-token: write                   # only if your cloud login uses OIDC

jobs:
  token:
    runs-on: ubuntu-latest
    outputs:
      token: ${{ steps.app.outputs.token }}
    steps:
      - id: app
        uses: actions/create-github-app-token@v2
        with:
          app-id: ${{ vars.KB_BUILDER_APP_ID }}
          private-key: ${{ secrets.KB_BUILDER_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}

  build:
    needs: token
    uses: AbsaOSS/knowledge-base/.github/workflows/build-image.yml@v1
    with:
      kb-ref: v1.0.0                # pin the build, not just the contract
      registry: apps.json
      image-name: ghcr.io/absaoss/knowledge-base
      image-tags: |
        ${{ github.sha }}
        latest
    secrets:
      docs-token: ${{ needs.token.outputs.token }}
```

Leave `image-name` empty for a dry run: the workflow builds, uploads `dist/` as
an artifact and pushes nothing. That is the right shape for a PR check on the
registry itself.

---

## Reading the docs repos: a GitHub App

Create a GitHub App — `knowledge-base-builder` — installed on every registered
docs repository with **`contents: read` and nothing else**. The build mints a
short-lived installation token per run.

Why an App rather than a personal access token:

- it is scoped to exactly the repositories it is installed on;
- the token expires in an hour, so a leaked log line is not a standing key;
- it belongs to the organisation, not to whoever created it and later left;
- adding a docs repo is "install the app", not "rotate a secret".

`scripts/fetch-apps.js` reads release assets through the API asset endpoint, so
private repositories work, and it passes the token as a request header rather
than on a command line (#43). An installation token is a `Bearer` token like any
other and needs no special handling.

Public docs repos need no App: when `docs-token` is omitted the workflow falls
back to `github.token`, which reads any public release. Pass the App token
anyway once a private repo is registered.

Neither the reusable workflow nor the publishing actions need the `gh` CLI on
the runner — every GitHub call goes through the REST API with a token from the
environment — so both run unchanged on self-hosted runners.

---

## Private networks: self-hosted runners and an internal registry

A deployment repository whose runners sit inside a private network — no route
to `registry.npmjs.org`, every package served by an internal Artifactory — sets
three more things and changes nothing else:

```yaml
  build:
    needs: token
    uses: AbsaOSS/knowledge-base/.github/workflows/build-image.yml@v1
    with:
      kb-ref: v1.0.0
      registry: apps.json
      image-name: artifactory.example.com/docker-local/knowledge-base
      registry-host: artifactory.example.com
      runs-on: '["self-hosted", "linux"]'
      npm-registry: https://artifactory.example.com/artifactory/api/npm/npm-remote/
      node-mirror: https://artifactory.example.com/artifactory/nodejs-remote   # if needed
    secrets:
      docs-token: ${{ needs.token.outputs.token }}
      npm-token: ${{ secrets.ARTIFACTORY_TOKEN }}
      registry-username: ${{ secrets.ARTIFACTORY_USER }}
      registry-password: ${{ secrets.ARTIFACTORY_TOKEN }}
```

| Input | What it covers |
|---|---|
| `runs-on` | A single label as it is; a JSON array or object for several labels or a runner group. Default `ubuntu-latest`. |
| `npm-registry`, `npm-token` (secret) | The `npm ci` of the build's own dependencies. Empty means whatever npm resolves on the runner. |
| `node-mirror`, `node-mirror-token` (secret) | Where `setup-node` downloads Node when it can reach neither the github.com release assets it tries first nor nodejs.org. A mirror of `https://nodejs.org` — an Artifactory generic remote. Not needed when the runner image carries Node 24 in its tool cache. |

The publishing actions take the same four inputs, so docs repos on the same
runners publish the same way (`actions/publish-docs/README.md`,
`SINGLE_PAGE.md`).

**Why the lockfile needs no change.** Every `resolved` URL in the lockfile
points at `registry.npmjs.org`, and it stays that way. npm's
`replace-registry-host` (default `npmjs`) rewrites that host to the configured
registry at fetch time; the `integrity` hashes still verify because the mirror
serves the same tarballs. That is what lets one lockfile, one workflow and one
action ref serve GitHub-hosted and internal runners alike. It is also why the
lockfile must never be regenerated behind a corporate `.npmrc`: npm rewrites
*only* the default host, so a lockfile carrying Artifactory URLs installs in
exactly one network. CI enforces the rule.

**What the registry input does not touch.** It is written as project-level npm
config next to the lockfile being installed, for that install only. The
runner's own npm configuration is layered underneath, not replaced — so a
runner that already carries an `~/.npmrc` naming the mirror can leave
`npm-registry` empty — and nothing is exported into the calling workflow's
later steps. The token is referenced from the environment, never written to
disk.

**What no workflow input can cover.**

- `docker build` pulls the nginx base image from Docker Hub by digest. On a
  private network that is a *daemon* setting — Artifactory's Docker remote as a
  `registry-mirrors` entry in the runner's `/etc/docker/daemon.json` — and the
  digest pin in the `Dockerfile` verifies the mirror served the same image.
- `setup-node`'s npm cache uses GitHub's cache service, and the App token comes
  from `api.github.com`. Both are on GitHub's published list of hosts a
  self-hosted runner must reach.
- Pushing the image goes to `registry-host` with `registry-username` /
  `registry-password`, which already cover an Artifactory Docker repository.

---

## Rebuilding when a docs repo publishes

The publishing actions accept `notify-repo` and `notify-token`. With both set,
a successful publish fires a `repository_dispatch` of type `kb-docs-published`
at the deployment repository, carrying `{ repo, tag, slugs }`:

```yaml
- uses: AbsaOSS/knowledge-base/actions/publish-docs@v1
  with:
    notify-repo: AbsaOSS/knowledge-base-deployment
    notify-token: ${{ secrets.KB_NOTIFY_TOKEN }}
```

`repository_dispatch` requires **`contents: write` on the target repository**.
That is a wider permission than the read token above, so scope it narrowly: a
fine-grained token (or App installation) whose only repository is the deployment
repo. Do not hand docs repos anything broader.

A failed notify never fails a publish — the artifact is already on the release,
and the nightly schedule picks it up. Treat the dispatch as an optimisation, not
a dependency.

---

## Rolling back

The image is immutable, so the fastest rollback is redeploying the previous tag
with your cloud's own tooling. To roll back the *content* rather than the image,
pin the offending entry in `apps.json` to its previous release and rebuild.

`dist/kb-build.json`, uploaded as the `kb-build-provenance` artifact and rendered
into the run's job summary, records what each build was assembled from:

```json
{
  "builtAt": "2026-09-04T13:44:49.043Z",
  "registry": "apps.json",
  "strict": true,
  "sources": [
    { "source": "AbsaOSS/my-service-docs", "version": "v1.4.0", "slugs": ["my-service"] }
  ]
}
```

This is the answer to "which release produced this page", which the registry
alone cannot give once `latest` has moved.

---

## Checklist for a new deployment repository

- [ ] `apps.json` with source-only entries, no `prebuilt` / `localPath` / `optional`
- [ ] GitHub App installed on every registered docs repo with `contents: read`
- [ ] `KB_BUILDER_APP_ID` variable and `KB_BUILDER_PRIVATE_KEY` secret set
- [ ] `build.yml` calling the reusable workflow with `kb-ref` pinned to a tag
- [ ] `strict` left at its default (`true`)
- [ ] Triggers: registry push, `repository_dispatch`, a schedule, manual
- [ ] `concurrency` set so a burst of publishes collapses into one build
- [ ] Docs repos that should trigger rebuilds have `notify-repo` / `notify-token`
- [ ] A dry-run check on PRs to the registry (`image-name` empty)
- [ ] On runners without a route to `registry.npmjs.org`: `runs-on`,
      `npm-registry` and the `npm-token` secret set; `node-mirror` if Node is
      neither preinstalled nor downloadable; the Docker daemon's mirror configured
