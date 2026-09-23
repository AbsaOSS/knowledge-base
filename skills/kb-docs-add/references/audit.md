# Audit path

The repo is already onboarded: it has a `kb-docs.json` or a workflow calling
`publish-docs` / `publish-single-page-docs`. The user wants it checked against the
contract, wants publish warnings gone, or reports docs that look or behave wrong inside
the knowledge base. Normative text: `contract/RULES.md` in `AbsaOSS/knowledge-base`. It
lists every rule by ID (`KB-HTML-003` …) with its reason and fix.

You do not judge compliance yourself. The checker does that, and you fix what it reports.
Every finding carries a rule ID, and the table below maps each ID to a change.

## 1. Check the wiring first

These are cheap and the checker cannot see them:

- The workflow pins `AbsaOSS/knowledge-base/actions/<action>@v1` (a major tag, never
  `@master` or a SHA nobody will bump), triggers on `release: published`, and has
  `permissions: contents: write`.
- `publish-docs`: the build step runs the **headless** variant, and `dist` is the directory
  that variant writes (mkdocs `site_dir`, Astro `outDir` …).
- `publish-single-page-docs`: every `md:` path exists, and the slugs are service-prefixed.
  The action renders the HTML itself, so there is no built output of yours to check.
  Stop after this step for a single-page repo.
- No pre-v1 names anywhere: `dist.tar.gz`, `marketplace.json`, `bundle.json`,
  `data-mp-headless`.

## 2. Get the built output

Check what the knowledge base will actually receive. In order of preference:

1. **Run the build step the workflow runs**, and check its output directory.
2. **Download the published artifact** when the build cannot run here (missing toolchain,
   private dependencies): `gh release download --pattern kb-docs.tar.gz`, then extract it.
   This audits the last release, not the working tree, so say so in the report.

If the workflow does not build the headless variant (step 1 found that), check its output
anyway: that is what gets published, and the findings, usually `KB-HTML-001` on every
page, show the user the cost. Then fix the workflow and audit the headless build. The
wiring fix is the top finding in the report.

An `error` finding fails the publish, and a `warning` does not. Trust the checker over the
user's description of the symptom. If the user says "warnings"
and the checker reports errors, say so. Their memory, or the last run they looked at, may
be out of date.

## 3. Run the checker

Use the knowledge base at the major version the workflow pins, so the rules match what
the publish runs:

```bash
git clone --depth 1 --branch v1 https://github.com/AbsaOSS/knowledge-base.git "$TMP/kb"
npm ci --omit=dev --prefix "$TMP/kb/actions"
node "$TMP/kb/actions/lib/check-cli.js" --manifest kb-docs.json --dist <output-dir> --json
```

`$TMP` is any scratch directory outside the repo. Never copy the checker into the repo.
If that tag has no `actions/lib/check-cli.js`, it predates the checker: clone without
`--branch` and tell the user that some rules are newer than their pinned action.
`--dist` is the build's output directory, the same value as the workflow's `dist` input.
For an extracted artifact it is the extraction root when the manifest lists several apps,
and the one app directory when it lists one.

Each finding is `{ id, severity, where, message }`. `where` is `<slug>/<file>`, relative
to the app's output directory.

## 4. Fix at the source, errors first

A finding names a file in the **output**. The fix goes in whatever produced it: the
generator config, the theme templates the team owns, their stylesheet or script, or
the markdown. Never edit built output: the next build undoes it.

| Rule | Usual cause → fix |
|---|---|
| `KB-MAN-001` | Schema problem. Each bullet names the field; see `troubleshooting.md`. |
| `KB-ART-001…003` | `dist` points at the wrong directory, or a `pages[].path` does not match the output layout (`foo.html` vs `foo/index.html`). |
| `KB-ART-004/005` | Uncompressed images, source maps, a vendored toolchain in the output. Exclude them from the build. |
| `KB-HTML-001` | The headless variant is not the one built, or the template misses the attribute (`packaged.md` §A). |
| `KB-HTML-002` | A template emits `<base>`. Remove it. |
| `KB-HTML-003` | Generator emits absolute paths: unset `site_url`/`base`/`baseurl`, enable relative URLs (see `troubleshooting.md`). |
| `KB-HTML-004` | Move the script body into a file under the site's assets and reference it with `<script src>`. If the inline script is the dark-mode bootstrap, the `KB-THEME-001` fix applies instead: leave it out of the headless build. |
| `KB-HTML-005/006` | `onclick=` / `href="javascript:…"`, often a menu or copy button. Give the element an id or class, and attach the listener from a script file. |
| `KB-HTML-007` | The site header survives in the headless variant. Hide it under the headless condition (`packaged.md` §A). |
| `KB-HTML-008` | A link to a PDF, ZIP, image … inside the app. Link to a page that embeds or describes it, or to the file on another origin (a release asset, a storage URL). You rarely know that URL: ask, or leave the finding with a note saying what the team must choose. |
| `KB-CSS-001` | `!important` in the team's own CSS: drop it and raise specificity. In a third-party theme's CSS: report it, do not patch. |
| `KB-THEME-001` | Dark-mode toggle or bootstrap still in the headless variant. Remove it under the headless condition. |
| `KB-CSP-001` | Web fonts or scripts from a CDN. Vendor the files into the site's assets and reference them relatively. Themes often have a switch for this (mkdocs-material: `theme.font: false`). A web font may also simply be left out of the headless build, so the page falls back to the rest of its `font-family` stack. Vendor it when the font matters to how the docs read and you can fetch it; otherwise leave it out. Say which you chose. A script cannot be left out if the page needs it: vendor it. |
| `KB-JS-001` | `fetch('data.json')` resolves against the host page. Use `new URL('data.json', import.meta.url)` in a module. In a classic script, read `document.currentScript.src` at top level: it is `null` inside callbacks. |

When a fix would mean re-implementing or forking a theme the team does not own, do not
make it. Record the rule, the file and why it stays. The same boundary as onboarding
applies: no new generator, no helper scripts, no wrapper actions, no `Makefile` targets.
New files that are part of the site are fine: the script a listener moves into, or a
vendored font. The ban is on tooling around the build, not on the site's own assets.

## 5. What the checker cannot see

Read the site's own scripts (not vendored libraries) for these. They are judgment calls,
so **report them; change them only when the fix is obvious and local**. Obvious and local
means one file, the same technique as a row above, and no change in what the page does.
One example: a base path computed from `location.pathname` becomes one resolved from the
script's URL. Anything that changes behaviour is the team's decision, so report it. Examples:
hiding a feature in the headless build, dropping a navigation, or links to content the
artifact does not contain (older doc versions, other sites).

- URLs assembled at runtime from `location.pathname`, `location.href`, `document.baseURI`
  or string concatenation. Embedded, the page URL is the **host's**, and a host router
  may strip the trailing slash. Resolving against the script's own URL is the fix
  (row `KB-JS-001` above).
- The site's own client-side routing: `history.pushState`, a SPA router, intercepted link
  clicks. The knowledge base does its own navigation between pages.
- `navigator.serviceWorker.register`, and anything reading or writing `localStorage`
  beyond UI state.

## 6. Re-check, then report

Rebuild and re-run the checker until it reports no errors. Warnings you left must each
have a reason in the report. If step 2 used the downloaded artifact, you cannot re-check.
Say that the next release's publish run is the verification.

Report:

- The checker's counts before and after (`N error(s), M warning(s)`). The before counts
  usually explain the user's symptom.
- A table of findings: rule, file, status (**fixed** with the change / **left** with the
  reason / **reported** for step 5 items). One row per rule and cause, with a count
  (`KB-HTML-005 ×3, every page`), not one row per page.
- The files changed, with full paths.
- The checker's final summary line, and whether it ran on a fresh build or the last
  release.
- The one manual step: publish a release so the fixed output reaches the knowledge base.
  The registry entry does not change.
- If the repo has no pull-request check yet, say that `AbsaOSS/knowledge-base/actions/check-docs@v1`
  runs these same checks on every PR (packaged sites only). Offer it, and write that
  workflow only if the user asks.
