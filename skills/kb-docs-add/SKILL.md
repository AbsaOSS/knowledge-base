---
name: kb-docs-add
description: Onboard a repository's documentation into the AbsaOSS knowledge base. Classifies the repo (markdown files → single-page, a static docs site → packaged, hosted elsewhere → iframe stopgap), writes only the files the contract requires (one workflow calling publish-single-page-docs, or kb-docs.json + a headless build flag + a publish-docs workflow), and explains how to verify the release carries kb-docs.tar.gz. Use whenever someone wants to publish docs to the knowledge base, add a repo or service to the knowledge base, write kb-docs.json, produce kb-docs.tar.gz, make a docs site headless for the knowledge base, or fix a failing publish-docs / publish-single-page-docs workflow — even when they only say "get our docs into the KB" or "our docs don't show up in the knowledge base". Also audits an onboarded repo: runs the contract checker, fixes findings by rule ID (KB-HTML-003…) at the source — for publish warnings or docs that break once embedded.
license: Apache-2.0
metadata:
  author: AbsaOSS
  source: https://github.com/AbsaOSS/knowledge-base/tree/master/skills/kb-docs-add
---

# Add docs to the knowledge base

The knowledge base is a build-time aggregator. It reads a registry of repos, downloads
`kb-docs.tar.gz` from each repo's GitHub Release, and re-hosts the HTML inside under its
own masthead. The archive holds a `kb-docs.json` manifest plus one directory per app.

**You never assemble that archive.** Two reusable actions in `AbsaOSS/knowledge-base`
validate, pack and upload it. Your whole job is to write the smallest set of files that
lets one of those actions run, then tell the user how to cut the release and register
the repo. The contract lives in `contract/` of that repo and is normative; this skill is
a guided path through it, not a replacement.

## 1. Classify the repo

Look at what the repo actually contains before writing anything.

**Already onboarded?** A `kb-docs.json`, or a workflow calling `publish-docs` /
`publish-single-page-docs`, means the job is an audit, not an onboarding: go to §6,
unless the user asks to publish something new from the repo.

| You find | Type | What you will write |
|---|---|---|
| Markdown files (README, `docs/*.md`, runbooks) and **no** docs-site generator | **single-page** | one workflow file |
| A docs *site*: `mkdocs.yml`, Starlight/Astro, Docusaurus, Jekyll, a `build` script that emits HTML | **packaged** | `kb-docs.json`, a headless build variant, one workflow file |
| Docs hosted elsewhere and no packageable source in this repo | **iframe** | nothing — explain, then stop |

Rules of thumb:

- A repo with a real site but only a page or two of prose is still *packaged*. The site is
  what the team maintains; do not replace it with single-page unless they ask.
- A repo with a generator config that is unused or broken is *single-page*. Onboarding is
  not the moment to resurrect a dead site.
- When two readings are plausible, say so and recommend single-page: it is one file,
  reversible, and the team can move to packaged later without touching the knowledge base.
- **iframe** is an explicit stopgap owned by the deployment repo's `apps.json`, not by
  the docs repo. Tell the user what the entry looks like — `type: "iframe"`, `url`,
  `slug`, `name`, `description`, optional `icon`/`tags`, and `temporary: true`; it is the
  one entry kind that carries display fields, because there is no manifest to read them
  from — that the external site must allow framing (`frame-ancestors` /
  `X-Frame-Options`), and stop. Do not write files.

## 2. Write the minimum, and nothing else

The action does the validating, packing and uploading. Anything you add on top of the
files below duplicates it, drifts from the contract the next time it changes, and is
exactly what a reviewer has to read and reject. So:

| Type | Allowed files | Not allowed |
|---|---|---|
| single-page | `.github/workflows/publish-docs.yml` | a manifest, a build script, `package.json` changes |
| packaged | `kb-docs.json` · `.github/workflows/publish-docs.yml` · the smallest change to the *existing* build that yields headless output | a new generator, a packing script, a vendored schema |

Never write `dist.tar.gz`, `marketplace.json`, `bundle.json`, `data-mp-headless` or any
other pre-v1 name — the action rejects them with a message pointing here. Never write a
helper script, `Makefile` target or wrapper action: if a check is worth having it belongs
in the action, and the action already runs it.

Pin the action to `@v1`, never `@master`. A breaking contract change ships as `@v2`.

## 3. Follow the path

- **single-page** → read `references/single-page.md`. Derive `title`, `description` and
  `slug` from the markdown; prefix every slug with the service name because slugs are
  global URLs across the whole knowledge base.
- **packaged** → read `references/packaged.md`. Make the existing build produce headless
  HTML, write `kb-docs.json` against the field table there, then the workflow. If the
  site's theme cannot be made headless without forking it, report the exact gaps and
  offer single-page instead — do not patch a third-party theme blindly.

`examples/` holds the workflow files and the manifest exactly as the contract prints
them. Copy from there and change only the values that describe this repo.

## 4. Verify

You cannot run the action locally — it needs a release to attach to — but you can make
its first run boring:

1. Every `md:` path (single-page) or `pages[].path` (packaged) exists in the checkout.
2. Every `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, 2–32 characters, and is
   service-prefixed. Every `description` is 10–280 characters.
3. Packaged only: run the headless build, then the action's own checker on the output
   (`references/audit.md` §3 has the three commands). No errors means the publish will
   not fail on the HTML. Fix warnings the same way (§4 there), or name them in the report.
4. The workflow has `permissions: contents: write` — the upload needs it and the error
   without it (`Resource not accessible by integration`) does not say so.

Then tell the user the two things only they can do:

- **Publish a GitHub Release.** The workflow triggers on `release: published`; the action
  attaches to an existing release and never creates one. Afterwards `kb-docs.tar.gz`
  must appear among the release assets.
- **Register the repo** with a PR to the deployment's `apps.json` adding
  `{ "repo": "owner/name", "version": "latest" }` — nothing more. Display fields come
  from the manifest, so later doc changes never touch the registry again.

## 5. When the run fails

Read `references/troubleshooting.md`: it maps every message the actions and the knowledge
base build emit to its cause and fix. Do not guess from the symptom — the messages are
specific on purpose. A message that starts with a rule ID (`KB-…`) is a checker finding:
`references/audit.md` §4 maps each ID to its fix.

## 6. Audit an onboarded repo

Read `references/audit.md`. In short: check the workflow wiring, build the headless output
(or download the last release's `kb-docs.tar.gz`), run the checker from a scratch
clone of the knowledge base, then fix each finding **at its source**, errors first:
config, the team's own templates, CSS, scripts or markdown. Never fix the built output,
and never patch a theme the team does not own. Also read the site's own scripts for
what the checker cannot see (URLs built from `location`, client-side routing), and report
those. Re-run until no errors remain.

## Report back

End with: the files written (full paths), the type you chose and why, the manual steps
above, and any contract requirement you could not satisfy from inside this repo. After an
audit, report instead in the shape `references/audit.md` §6 gives: every finding with its
status.
