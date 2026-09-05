# `publish-single-page-docs` action

Renders plain markdown files into headless single-page docs and attaches them to
your repository's latest GitHub Release as `dist.tar.gz`, ready for the AbsaOSS
knowledge base to pick up.

```yaml
- uses: AbsaOSS/knowledge-base/actions/publish-single-page-docs@v1
  with:
    docs: |
      - md: docs/overview.md
        title: Service Overview
        description: What the service does and how to use it.
        slug: my-service
```

**Full documentation — inputs, the copy-paste workflow and troubleshooting — lives
in [`contract/SINGLE_PAGE.md`](../../contract/SINGLE_PAGE.md); the artifact and
manifest it produces are specified in
[`contract/ARTIFACT.md`](../../contract/ARTIFACT.md).**

If your docs are a real site rather than a markdown file or two, you want
[`publish-docs`](../publish-docs) instead.

---

## Layout

| Path | Role |
|---|---|
| `action.yml` | Composite action: setup-node → `npm ci` → render → upload (`github-script`, replacing any existing asset) |
| `src/index.js` | Entry point. Reads inputs from env, writes step outputs. |
| `src/inputs.js` | Parses and validates the `docs` list. Every message names the entry and the fix. |
| `src/markdown.js` | markdown-it pipeline: GFM, highlight.js, mermaid passthrough. |
| `src/template.js` | The headless document shell and `assets/doc.css`. **Dependency-free** — also imported by the knowledge base's test fixture generator, so the fixture cannot drift from real output. |
| `src/bundle.js` | Stages the doc directories, then delegates the manifest and the packing to `actions/lib/`. |
| `src/selftest.js` | `npm run selftest` — renders a sample end to end and pins the validation messages. |

Dependencies are pinned once in [`actions/package.json`](../package.json), shared
with the packaged-site action, so an onboarding repo needs no toolchain of its
own. Manifest validation, deterministic packing, the runner plumbing and the
release upload (`release.cjs`) live in [`actions/lib/`](../lib) and are the same
code both actions run.

## Runner requirements

Nothing beyond what the runner itself provides, so self-hosted runners work
unchanged: Node comes from `actions/setup-node`, the release upload goes through
`actions/github-script` and its Octokit client rather than the `gh` CLI,
and `bash` is needed only for the two one-line `run:` steps. The runner must
support Node 24 actions (`actions/runner` ≥ 2.327.1), as `actions/setup-node@v7`
already requires. See the [`publish-docs` README](../publish-docs/README.md#runner-requirements)
for the full list.

## Working on it

```bash
cd actions
npm ci
npm run selftest                # both actions
npm run selftest:single-page    # this one
```

The self-test is deliberately **not** part of the knowledge base's Playwright
suite: that suite must stay hermetic and must not depend on this action's
`node_modules`. The knowledge base side of the feature is covered there instead, via
the `tests/fixtures/single-page-bundle/` fixture.
