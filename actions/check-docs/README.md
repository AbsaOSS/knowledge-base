# check-docs

Runs the knowledge base contract checks on a docs repo's built headless site, on a pull
request. It uses the same checker the [`publish-docs`](../publish-docs) action runs at
release time, but it does not release or upload anything. A finding that would fail the
publish fails the pull request instead, one release earlier.

```yaml
# .github/workflows/check-docs.yml in the docs repo
name: Check docs

on:
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # The same headless build the publish workflow runs.
      - run: npm ci && npm run build -- --headless

      - uses: AbsaOSS/knowledge-base/actions/check-docs@v1
        with:
          manifest: kb-docs.json
          dist: dist
```

Every rule it checks is in [`contract/RULES.md`](../../contract/RULES.md), by ID.

- **Error findings fail the check.** These are what `publish-docs` refuses to release.
- **Warning findings do not fail it**, unless `strict: true`. They are annotated on the
  run, one annotation per rule with a count and the first example.
- **The job summary** tables every rule and lists every finding.

This is for **packaged** sites only. A repo that uses
[`publish-single-page-docs`](../publish-single-page-docs) has no built output of its own
to check: the action renders the markdown itself.

## Inputs

| Input | Default | |
|---|---|---|
| `manifest` | `kb-docs.json` | Path to the manifest, relative to the workspace. |
| `dist` | `dist` | The built headless output, relative to the workspace. Use the same value the publish workflow passes. |
| `strict` | `false` | `true` fails on warnings as well as errors. |
| `npm-registry`, `npm-token`, `node-mirror`, `node-mirror-token` | | For runners without public internet. The same inputs as `publish-docs`; see [`contract/DEPLOYMENT.md`](../../contract/DEPLOYMENT.md) → "Private networks". |

## Outputs

| Output | |
|---|---|
| `errors` | Number of error findings. |
| `warnings` | Number of warning findings. |

The same checks run locally with `node actions/lib/check-cli.js` from a checkout of this
repository; see `contract/RULES.md` → "Running the checks".
