# Deployment repository skeleton

Copy this directory into a new **private** repository. It is the whole of what a
knowledge base deployment owns: a registry, a build workflow that calls the
public one, and a PR check on the registry itself.

The reasoning behind each piece is in
[`contract/DEPLOYMENT.md`](../../contract/DEPLOYMENT.md).

```
.
├─ apps.json                     # the production registry
└─ .github/workflows/
   ├─ build.yml                  # build + push on publish, on registry change, nightly
   └─ registry-check.yml         # dry run on PRs that touch the registry
```

## Before the first build

1. **Create a GitHub App** (`knowledge-base-builder`) with `contents: read`, and
   install it on every docs repository you register. The build mints a
   short-lived installation token from it per run — no long-lived secret.
2. Set the repository variable `KB_BUILDER_APP_ID` and the secret
   `KB_BUILDER_PRIVATE_KEY`.
3. Replace `ghcr.io/absaoss/knowledge-base` in `build.yml` with your image, and
   pin `kb-ref` to a released tag of `AbsaOSS/knowledge-base`.
4. Put your real entries in `apps.json`.
5. If the build has to run on self-hosted runners inside a private network,
   uncomment `runs-on`, `npm-registry` and `npm-token` in `build.yml` — the
   "Private networks" section of `contract/DEPLOYMENT.md` explains each.

## What is deliberately not here

`deploy.yml`. Getting a pushed image running — ECS, Kubernetes, anything else —
is your cloud's business, and the environments and approvals around it are
usually the part with real policy attached. This skeleton ends at "an image is
pushed", which is where the knowledge base's responsibility ends too.
