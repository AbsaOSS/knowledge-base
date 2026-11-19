# Deploying the knowledge base

Deployment is **not** part of this repository, and that is deliberate. A private
deployment repository owns the production registry, the cloud account and the
schedule. This repository is the build tool it calls.

This document is the definition that private repository is built from. The
copy-paste skeleton is in [`examples/deployment-repo/`](../examples/deployment-repo).

---

## Optional telemetry

Telemetry is excluded from builds by default: UI Watchtower, the shell adapter
and the telemetry metadata are left out, and the files below are not read. Set
the reusable workflow input `telemetry: true` (or `KB_TELEMETRY=true` locally)
to include it. Any value other than `true`, `false` or empty fails the build.

The enabled build reads a sidecar beside the registry: `apps/dev.json` →
`apps/dev.telemetry.json`, `apps.json` → `apps.telemetry.json`.
`KB_TELEMETRY_CONFIG` overrides the path (absolute or relative to the
application root).

```json
{
  "enabled": true,
  "application": "documentation",
  "environment": "TEST",
  "eventNamespace": "com.example"
}
```

| Field | Contract |
|---|---|
| `enabled` | Boolean. Enable only in environments approved for telemetry, and keep it in step with the shell's own telemetry switch. |
| `application` | Non-empty string; the fragment's identity, distinct from the host's. |
| `environment` | Non-empty string; the deployment label. |
| `eventNamespace` | Non-empty string; the host's Watchtower event namespace. |

KB adds `version` itself: its package version plus the source commit.

Unknown fields, wrong types, invalid JSON and an explicit path that does not
exist fail the build. An absent sidecar disables event forwarding. The values
are emitted into the page, so **they are readable by users**: never put
credentials, monitor IDs or private endpoints in them.

### Shell adapter

The knowledge base does not know which host shell embeds it. The deployment
supplies that knowledge as an ES module, `kb-shell.mjs`, beside its registry
(`apps/kb-shell.mjs` for `apps/dev.json`); `KB_SHELL_ADAPTER` overrides
discovery (absolute or relative to the application root, and must exist).
Without one, the built-in `src/scripts/no-shell.js` is used and the knowledge
base runs shell-less. The adapter is bundled into the page script at build time
(so `script-src 'self'` holds), must be self-contained — no imports — and
applies to every registry in its directory. It is trusted build input: only the
deployment that owns the registry may supply it.

```js
/** @returns {null | { channelName?: string, ready(): void, failed(): void, dispose?(): void }} */
export function connectShell(window) {
  if (!insideMyShell(window)) return null;
  return {
    channelName: /* the shell's per-page Watchtower channel, if it has one */,
    ready() { /* page initialized: tell the shell */ },
    failed() { /* page has no knowledge base shell: tell the shell */ },
    dispose() { /* remove listeners and timers */ },
  };
}
```

`connectShell` is called once per page realm. Returning `null` means "not in
my shell": nothing is forwarded or reported. `ready()` (or `failed()`, when no
knowledge base masthead rendered) is called on each page activation — the
initial load and each internal navigation — regardless of `enabled`, so a
shell's readiness protocol keeps working with event forwarding off. An adapter
whose shell expects a single answer deduplicates the calls itself. Events are
forwarded only when `enabled` is true and `channelName` is a non-empty string;
the shared default channel is never used. A throwing adapter is contained and
the page falls back to running shell-less.

When the shell removes the knowledge base, the knowledge base disposes its
telemetry, the adapter's `dispose()` included, on `unload` or on a
`web-fragment-unmount` event on its `window`. Chromium can refuse `unload`, and
web-fragments 0.8.2 cleans up only on `unload`
([web-fragments#302](https://github.com/web-fragments/web-fragments/issues/302)),
so a shell should patch its web-fragments to dispatch `web-fragment-unmount` on
the fragment's shadow root (where web-fragments delivers a fragment's `window`
listeners) before it removes the iframe. Without that, nothing fails, but
nothing is disposed either.

The shell provides a Watchtower BroadcastChannel receiver
(`UwtTelemetryBroadcastHost`, or `ngx-ui-watchtower` 0.4.0+) on that channel
and the same event namespace. The shell owns RUM, credentials, session/user
identity and page views; KB never calls a credential endpoint or changes user
identity.

The knowledge base sends no events of its own yet. Future events are declared
in `src/telemetry.schema.ts`.

No document text/title, query/hash, full URL, search text or raw errors are
captured by KB. The shell's own SDK may attach its standard RUM envelope; the shell's
privacy and retention policy still applies. `debugBI` and `debugScenario`
localStorage flags enable safe local diagnostics. The integration creates no
cookies or persistent telemetry storage.

For local verification, use a non-production configuration:

```bash
KB_TELEMETRY=true KB_TELEMETRY_CONFIG=/path/to/local.telemetry.json \
KB_SHELL_ADAPTER=/path/to/deployment/apps/kb-shell.mjs npm run build:headless
npm run serve:test   # then run the host shell against :3000
```

Verify initial access, Library -> document -> Library, deep links, retry/remount,
two tabs, disabled/bad configuration and standalone behavior. Inspect actual
receiver traffic as well as sender diagnostics; a test-host receiver is not
proof of CloudWatch ingestion. No new CSP allowlist is necessary.

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
| Host shell integration, telemetry identity | ❌ generic engine and adapter contract | ✅ `kb-shell.mjs`, `*.telemetry.json` |

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
| an artifact with an `error` finding ([`RULES.md`](./RULES.md)) | The publish action refuses those; an artifact that has one reached the release some other way (hand-packed, or an action older than the rule) |

Every build, strict or not, runs the contract checks on each installed artifact and logs
the findings grouped by rule, so the registry owner can see which docs repo to chase.
Warnings never fail a build.

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
      ca-certificates: ${{ secrets.CORP_CA_PEM }}   # behind a TLS-intercepting proxy
```

| Input | What it covers |
|---|---|
| `runs-on` | A single label as it is; a JSON array or object for several labels or a runner group. Default `ubuntu-latest`. |
| `npm-registry`, `npm-token` (secret) | The `npm ci` of the build's own dependencies. Empty means whatever npm resolves on the runner. |
| `node-mirror`, `node-mirror-token` (secret) | Where `setup-node` downloads Node when it can reach neither the github.com release assets it tries first nor nodejs.org. A mirror of `https://nodejs.org` — an Artifactory generic remote. Not needed when the runner image carries Node 24 in its tool cache. |
| `ca-certificates` (secret) | Extra CA certificates (PEM) for the image build's `apk upgrade`, which otherwise fails behind a TLS-intercepting proxy with `TLS: server certificate not trusted` (exit 99): the base image trusts public CAs only. Written to `trusted_certs/` before `docker build`; the Dockerfile appends every `*.pem`/`*.crt` there to the system CA bundle. A pipeline running `docker build` itself drops the files into `trusted_certs/`, or passes `--build-arg TRUSTED_SSL_CERTS=<dir>`. The certificates stay in the image. |

The publishing actions take the same four inputs, so docs repos on the same
runners publish the same way (`actions/publish-docs/README.md`,
`SINGLE_PAGE.md`).

**Why the lockfile needs no change.** The lockfile names no registry: the
`.npmrc` committed beside it sets `omit-lockfile-registry-resolved=true`, so
each package carries a version and an `integrity` hash but no `resolved` URL.
npm fetches it from whichever registry is configured at install time, and the
hash still verifies because the mirror serves the same tarballs. That is what
lets one lockfile, one workflow and one action ref serve GitHub-hosted and
internal runners alike. CI fails if a lockfile gains a registry URL.

**What the registry input does not touch.** It is appended to the project-level npm
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
