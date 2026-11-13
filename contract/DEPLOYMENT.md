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
| The build | ✅ `scripts/`, `src/`, `Dockerfile`, `nginx.conf`, `mcp-server/` | — |
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

## The MCP server

The knowledge base can also be searched and read by AI agents over the
[Model Context Protocol](https://modelcontextprotocol.io) at
`/knowledge-base/mcp`. The server is a second image, built from the same
`dist/` in the same run, and it runs **beside the site image in one task**.
Why it is shaped this way: [`docs/adr/0001-mcp-server.md`](../docs/adr/0001-mcp-server.md).
What agents and operators see: [`docs/mcp.md`](../docs/mcp.md).

It is opt-in. Name the image and the workflow builds and pushes it with the
same tags as the site image:

```yaml
    with:
      image-name: ghcr.io/absaoss/knowledge-base
      mcp-image-name: ghcr.io/absaoss/knowledge-base-mcp
```

The workflow's `mcp-image` output is the first reference it pushed. Deploy the
two images **together, at the same tag**: the MCP image carries the search index
of the very build the site image serves.

### The task

| | Site container | MCP container |
|---|---|---|
| Image | `image-name` | `mcp-image-name` |
| Listens on | `8080` (published) | `127.0.0.1:8081` (never published) |
| Health check | `GET /healthz` on `8080` | `GET /healthz` on `8081` |
| Essential | yes | yes |
| Starts after | the MCP container is `HEALTHY` | — |
| CPU / memory | 0.25 vCPU / 128–256 MiB | 0.25 vCPU / 256–512 MiB |
| Root filesystem | — | read-only is fine |

Both containers must share a network namespace: nginx proxies the endpoint to
`127.0.0.1:8081`. ECS tasks in `awsvpc` mode (Fargate) and Kubernetes pods share
one already; ECS `bridge` mode does not.

A complete Fargate task definition is in
[`examples/deployment-repo/ecs-task-definition.json`](../examples/deployment-repo/ecs-task-definition.json).
Two things in it are easy to miss:

- **The health checks are in the task definition.** Both images carry a Docker
  `HEALTHCHECK`, but ECS ignores it: a container without a `healthCheck` in the
  task definition never becomes `HEALTHY`, and a `dependsOn` waiting for that
  never lets the site container start.
- **One tag for both images.** The MCP image holds the search index of the build
  the site image serves; deploy them as a pair, from the same workflow run.

Sizing: the MCP container idles at about 60 MiB, plus the index, which the
operating system caches as it is read. Its CPU goes to search queries, a few
milliseconds each. Raise the memory with the size of the content, not with
traffic; scale with traffic by running more tasks.

A task that runs the site image alone still serves every page; only
`/knowledge-base/mcp` answers `502`.

### Settings

All optional; set on the MCP container.

| Variable | Default | What it does |
|---|---|---|
| `KB_MCP_PUBLIC_ORIGIN` | unset | The origin the site is served from, e.g. `https://docs.example.com`. Results then carry absolute links an agent can hand to a person; without it they carry the route only. |
| `KB_MCP_ALLOWED_ORIGINS` | none | Comma-separated browser origins allowed to call the endpoint. Agents send no `Origin` and always pass; a browser page from any origin not listed gets `403`. |
| `KB_MCP_MAX_CONCURRENCY` | `32` | Requests handled at once; beyond it the server answers `503`. |
| `KB_MCP_LOG_LEVEL` | `info` | uvicorn's log level. |

`KB_MCP_INDEX`, `KB_MCP_HOST`, `KB_MCP_PORT` and `KB_MCP_ALLOWED_HOSTS` default
to what the image and the nginx upstream expect; leave them alone.

### In front of the task

nginx already limits each client to 20 requests a second (burst 40), all
clients together to 200 (burst 400), and a request body to 64 KiB. The per-client
limit keys on the address in `X-Forwarded-For` when the hop that sent it is in a
private range (`10/8`, `172.16/12`, `192.168/16`) — a load balancer in the VPC.

Whatever sits in front must forward `POST`, `GET` and `OPTIONS
/knowledge-base/mcp` to the task unchanged and **unauthenticated**: MCP clients
call it directly, not through a browser session. The endpoint is read-only and
serves exactly what the site serves; restrict it at the network level if the
site itself is restricted.

**The web-fragments gateway cannot carry it.** The gateway's Node middleware
(`getNodeMiddleware`, web-fragments 0.8.2) rebuilds every request that has a
body without `duplex: 'half'`, so every MCP call and every preflight fails with
a `500` (`RequestInit: duplex option is required when sending a body`). It
also answers a browser opening the URL with the app shell. The pattern
`/knowledge-base/:_*` that routes the site to the fragment matches the MCP path
too, so the path has to be taken out of the gateway's hands, in one of two
ways:

1. **At the load balancer (preferred).** A listener rule for the exact path
   `/knowledge-base/mcp`, at a higher priority than the gateway's, forwarding
   to the knowledge base target group. No host code, and the gateway never sees
   the request.
2. **In the host application, before the gateway middleware.** A plain reverse
   proxy for that one path, mounted ahead of `getNodeMiddleware`. In an Angular
   SSR host's `server.ts`, with `http-proxy-middleware`:

   ```ts
   import { createProxyMiddleware } from 'http-proxy-middleware';

   // Before app.use(getNodeMiddleware(gateway)): the gateway cannot forward a request body.
   app.use(createProxyMiddleware({
     pathFilter: '/knowledge-base/mcp',
     target: KNOWLEDGE_BASE_ENDPOINT,   // the same endpoint the fragment is registered with
     changeOrigin: true,
     xfwd: true,                        // X-Forwarded-For, for nginx's per-client limit
   }));
   ```

   `tests/host/server.mjs`, the reference host the test suites use, does the
   same without the dependency, and `npm run test:container` calls a tool
   through it.

### Enabling it in an existing deployment

The site image from the same release works with or without the MCP container,
so nothing has to happen at once:

1. Pin `kb-ref` to a release that has `mcp-image-name`.
2. Create the MCP image repository (ECR does not create one on push), set
   `mcp-image-name`, and let a build push both images.
3. Route `/knowledge-base/mcp` to the task, around the gateway (above). Until
   the next step it answers `502`; nothing else changes.
4. Add the MCP container to the task definition: its health check, the site's
   `dependsOn`, `KB_MCP_PUBLIC_ORIGIN`, and the same tag as the site image.
   Deploy.
5. Check it from outside:

   ```sh
   curl -s https://docs.example.com/knowledge-base/mcp \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_documents","arguments":{"query":"release"}}}'
   ```

   A JSON result with `"total"` is the whole path working. Then connect an agent
   ([`docs/mcp.md`](../docs/mcp.md)).

Rolling back is removing the MCP container from the task definition; the site
is unaffected.

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

With an MCP image (`mcp-image-name`), its Python dependencies need a mirror too:

```yaml
    with:
      python-index: https://artifactory.example.com/artifactory/api/pypi/pypi-remote/simple
    secrets:
      python-index-username: ${{ secrets.ARTIFACTORY_USER }}
      python-index-token: ${{ secrets.ARTIFACTORY_TOKEN }}
```

| Input | What it covers |
|---|---|
| `runs-on` | A single label as it is; a JSON array or object for several labels or a runner group. Default `ubuntu-latest`. |
| `npm-registry`, `npm-token` (secret) | The `npm ci` of the build's own dependencies. Empty means whatever npm resolves on the runner. |
| `node-mirror`, `node-mirror-token` (secret) | Where `setup-node` downloads Node when it can reach neither the github.com release assets it tries first nor nodejs.org. A mirror of `https://nodejs.org` — an Artifactory generic remote. Not needed when the runner image carries Node 24 in its tool cache. |
| `python-index`, `python-index-username` / `python-index-token` (secrets) | The MCP image's Python dependencies: a PyPI simple index, an Artifactory PyPI remote, say. Empty means PyPI. The URL goes without credentials; the workflow adds the secrets to it and hands the result to `docker build` as a BuildKit secret, so it is in no layer and no image history. The username defaults to `__token__`. |
| `ca-certificates` (secret) | Extra CA certificates (PEM) for the image build's `apk upgrade`, which otherwise fails behind a TLS-intercepting proxy with `TLS: server certificate not trusted` (exit 99): the base image trusts public CAs only. Written to `trusted_certs/` before `docker build`; the Dockerfile appends every `*.pem`/`*.crt` there to the system CA bundle. A pipeline running `docker build` itself drops the files into `trusted_certs/`, or passes `--build-arg TRUSTED_SSL_CERTS=<dir>`. The certificates stay in the image. |

The publishing actions take the same four inputs, so docs repos on the same
runners publish the same way (`actions/publish-docs/README.md`,
`SINGLE_PAGE.md`).

**Why the lockfiles need no change.** The npm lockfile names no registry: the
`.npmrc` committed beside it sets `omit-lockfile-registry-resolved=true`, so
each package carries a version and an `integrity` hash but no `resolved` URL.
npm fetches it from whichever registry is configured at install time, and the
hash still verifies because the mirror serves the same tarballs. That is what
lets one lockfile, one workflow and one action ref serve GitHub-hosted and
internal runners alike. CI fails if a lockfile gains a registry URL.
`mcp-server/uv.lock` does name PyPI, so the MCP image never installs from it
directly: it exports the lock to requirements with every hash and no index URL,
and installs those with `--require-hashes` from whichever index is configured.

**What the registry input does not touch.** It is appended to the project-level npm
config next to the lockfile being installed, for that install only. The
runner's own npm configuration is layered underneath, not replaced — so a
runner that already carries an `~/.npmrc` naming the mirror can leave
`npm-registry` empty — and nothing is exported into the calling workflow's
later steps. The token is referenced from the environment, never written to
disk.

**What no workflow input can cover.**

- `docker build` pulls the nginx base image from Docker Hub by digest (and,
  for the MCP image, `python` from Docker Hub and `uv` from `ghcr.io`). On a
  private network that is a *daemon* setting — Artifactory's Docker remote as a
  `registry-mirrors` entry in the runner's `/etc/docker/daemon.json` — and the
  digest pins in the Dockerfiles verify the mirror served the same image.
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
- [ ] With the MCP server: `mcp-image-name` set and its image repository
      created; both containers in one `awsvpc` task with `healthCheck`s in the
      task definition and the site `dependsOn` the MCP container `HEALTHY`;
      `KB_MCP_PUBLIC_ORIGIN` set; `/knowledge-base/mcp` routed to the task
      around the web-fragments gateway, unauthenticated; `python-index` and its
      secrets on a private network
