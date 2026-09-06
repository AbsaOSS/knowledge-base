# Troubleshooting

Every message below is emitted verbatim (modulo the names in quotes) by one of the
publishing actions, by GitHub Actions itself, or by the knowledge base build. Find the
message, apply the fix, republish. Do not add a workaround step to the workflow: the
actions are the interface, and a fix that lives outside them will be lost on the next
contract change.

## Workflow never runs, or fails before the action

| Symptom | Cause → fix |
|---|---|
| Nothing happens after publishing a release | The workflow file is not on the default branch yet, or the trigger is not `release: types: [published]`. A *draft* release does not fire it; publish it. |
| `Unable to resolve action AbsaOSS/knowledge-base/actions/publish-docs@…` | Wrong ref. Pin `@v1`. An old fork may still say `@master` or use a path that no longer exists. |
| `Resource not accessible by integration` at the upload step | Missing `permissions: contents: write`. The default token is read-only in many orgs. Add the block at job level (single-page example) or workflow level (packaged example). |
| The build step fails | Not the action's problem. Run the same command locally; the action never starts until the build has produced `dist`. |

## `publish-single-page-docs` input errors

All reported at once, each naming `docs[i]` and the fix.

| Message | Fix |
|---|---|
| `` `docs` is empty `` / `` `docs` is an empty list `` | The `docs:` input is a YAML **list** under a `|` block scalar. Check indentation. |
| `` `docs` is not valid YAML/JSON `` | Usually a `:` inside `description` — quote the value. |
| `md "…" does not exist in the repository` | Wrong path, or `actions/checkout` is missing before the action. |
| `md "…" must be a repository-relative path inside the checkout` | No leading `/`, no `..`. |
| `slug "…" is invalid` | Lowercase letters, digits, single hyphens: `^[a-z0-9]+(-[a-z0-9]+)*$`. No underscores, capitals, spaces. |
| `slug "…" must be 2–32 characters long` | Shorten; keep the service prefix. |
| `slug "…" is already used by docs[n]` | Each doc needs its own slug. |
| `title is N characters — keep it under 128` | Shorten the title. |
| `description is N characters — it must be 10–280` | One sentence. Not the whole first paragraph. |
| `icon "…" is not supported` | Pick from the icon set in `single-page.md`, or drop the field. |
| `unknown field "…"` | Allowed fields are `md title description slug icon tags`. Probably `name` instead of `title`. |

## `publish-docs` manifest and HTML errors

| Message | Fix |
|---|---|
| `No manifest at kb-docs.json` | Put `kb-docs.json` at the repo root, or set the `manifest` input to where it is. |
| `kb-docs.json is not valid JSON` | Trailing comma or comment. JSON, not JSONC. |
| `kb-docs.json does not satisfy the knowledge base contract:` … | Each bullet names the field. Common: `kbVersion` as a number (must be the string `"1"`), `description` too short, `slug` with a capital, an unknown key in `pages[]`. |
| `<slug>: entryPoint "index.html" does not exist in the built output` | The `dist` input points at the wrong directory, or the build writes somewhere else (mkdocs `site_dir`, Astro `outDir`). For a one-app manifest `dist` is the app directory itself, not its parent. |
| `<slug>: pages entry "…" points at "…", which is not in the built output` | Path in `pages[]` does not match the generator's output layout (`foo.html` vs `foo/index.html`). Fix the path or drop `pages`. |
| `<slug>: the built output contains no HTML at all` | Wrong `dist`, or the build failed silently. |
| `<slug>/…: missing data-kb-headless="true" on <html>` | The headless variant was not the one built, or the template does not emit the attribute. See `packaged.md` §A. |
| `<slug>/…: carries data-mp-headless, the pre-v1 marker` | Rename the attribute to `data-kb-headless`. |
| `<slug>/…: contains a <base> element` | Remove it. Relative paths make it unnecessary. |
| `<slug>/…: N root-relative URL(s), e.g. "/assets/…"` | The generator emits absolute paths: unset `site_url`/`base`/`baseurl`, or configure relative URLs (`use_directory_urls`, `trailingSlash`, `relativeurls`). |
| `::warning:: … inline <script> block(s)` | Not a failure. Ship scripts as files if you want control over what runs. |

## Release and upload

| Message | Fix |
|---|---|
| `has no GitHub Release to attach the docs bundle to` | The repo has no releases. Publish one; the action never creates releases. Or pass `release-tag`. |
| The asset is on the wrong release | The action attaches to the release that triggered the run, else the latest. On `workflow_dispatch` that means latest — pass `release-tag` to target another. |
| Asset uploaded, but the old one is still there | It is replaced by name (`kb-docs.tar.gz`). A leftover `dist.tar.gz` from a pre-v1 workflow is a different asset; delete it by hand once. |

## Private-network runners

| Message | Fix |
|---|---|
| `npm error … ENOTFOUND registry.npmjs.org` or a proxy `403` at *Install publisher dependencies* | The runner cannot reach the public registry. Set `npm-registry` (and `npm-token`) on the action step to the internal mirror. Do not edit the runner's `.npmrc` from the workflow. |
| `Unable to find Node version` / download error at *Set up Node.js* | The runner reaches neither github.com release assets nor nodejs.org. Set `node-mirror` (and `node-mirror-token`), or preinstall Node 20 in the runner tool cache. |
| Runner too old for the action | `actions/setup-node@v7` needs `actions/runner` ≥ 2.327.1. |

Details: `contract/DEPLOYMENT.md` → "Private networks".

## Knowledge base build (after registering)

These surface in the *deployment* repo's build, not in the docs repo.

| Message | Fix |
|---|---|
| `Duplicate app slug "…"` | Another registered repo already owns that URL. Rename the slug and republish. This is why slugs carry a service prefix. |
| `the release artifact has no kb-docs.json at its root` | The asset on the release was not produced by the action (hand-tarred, or a pre-v1 `dist.tar.gz`). Let the action publish it. |
| `apps.json: an entry names no artifact` | The registry entry needs `repo`. |
| Registry entry rejected for carrying `slug`/`name`/`description`/… | The registry is source-only: `{ "repo": "owner/name", "version": "latest" }` and nothing else. Display fields live in the manifest. |
| Docs not updated after a new release | The knowledge base builds on a schedule or on `repository_dispatch`. Either wait for the next build, or ask the deployment owners to enable `notify-repo`/`notify-token` on your action step. |
| Artifact size warning `> 20 MB` | Uncompressed images or a vendored toolchain in the build output. A docs bundle is HTML, CSS, fonts and images only. `> 100 MB` is refused. |

## Still stuck

- `contract/SINGLE_PAGE.md` → "Troubleshooting" and `actions/publish-docs/README.md`
  → "What it checks" are the upstream tables this page mirrors.
- Run the action's self-test in a checkout of `AbsaOSS/knowledge-base` (`cd actions &&
  npm ci && npm run selftest`) to see every message it can emit and the input that
  triggers it.
