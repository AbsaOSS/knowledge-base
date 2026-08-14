# AGENTS.md

Working agreement for automated agents and contributors making changes in this
repository. It exists so a change lands green on the first CI run instead of the
third.

Read [`CLAUDE.md`](CLAUDE.md) for the architecture and [`CONTRIBUTING.md`](CONTRIBUTING.md)
for the human-facing summary. This file is the mechanical checklist.

## Non-negotiables

CI enforces every rule in this section. `.github/workflows/pr-requirements.yml`
runs `AbsaOSS/check-pr-requirements` on every PR event, so a PR that violates a
rule is red before any code is looked at.

### Branch name

```
^(feat|feature|fix|bugfix|hotfix|release|support|chore|docs|ci|test|dependabot)/[a-zA-Z0-9._/-]+$
```

Branch off `master`. `master` is the only allowed target branch.

Examples: `fix/build-pipeline-hardening`, `docs/agents-guide`, `chore/asset-copy`.

> **The branch prefixes are not the same set as the commit/PR title types.**
> `perf`, `refactor`, `style`, `build` and `revert` are valid *title* types but
> **invalid branch prefixes** — a `perf/…` branch fails the check. Use `chore/…`
> (or `fix/…`) for that work and keep the `perf:` prefix in the title.

### PR title — Conventional Commits

```
<type>: <summary>
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`. A scope is optional (`fix(build): …`).

### PR description

- **At least 20 characters.** A one-word body fails.
- **Must reference an issue.** Use a closing keyword so the issue is resolved on
  merge: `Closes #42`. Reference every issue an aggregated PR resolves, each on
  its own line.

Template that satisfies the checker:

```markdown
## What

One paragraph on what changed and why.

## Changes

- `path/to/file.js` — what and why

## Verification

- `npm run build:headless` — green
- `npm test` — green
- `npx playwright test --config=playwright.config.ci.js` — green

Closes #42
Closes #43
```

### Size

**Maximum 50 changed files per PR.** Split larger work.

## Commits

Conventional Commits, same type list as PR titles. Keep the subject under ~72
characters and explain *why* in the body when it is not obvious from the diff.

## Before opening a PR

All three must pass locally — CI runs the same three:

```bash
npm run build:headless                                  # hermetic build
npm test                                                # embedded web-fragment E2E
npx playwright test --config=playwright.config.ci.js    # standalone fragment layer
```

The build and both suites are hermetic: they use the committed
`tests/fixtures/` artifacts via `apps.json`, so no `GITHUB_TOKEN`, no network and
no sibling repository is required. If a change makes any of them need network,
that is the bug — fix the change, not the test.

A fourth suite needs Docker and is therefore **not** part of `npm test`:

```bash
npm run test:container   # integration tests against the real nginx image
```

Run it when touching `nginx.conf`, `nginx.headers.conf` or the `Dockerfile`. It
is the only place the shipped config is executed — the other suites run against
`tests/fragment-server.mjs`, an Express mirror of the nginx rewrites. That mirror
is a second implementation of the same contract and it has drifted twice
(#45, #60), so **a change to nginx behaviour means changing both, and proving it
with this suite.** CI runs it inside the `image` job, which already builds the
image.

`npm audit --omit=dev --audit-level=high` must also stay clean; it gates CI.

## Repository conventions

### Hermetic by construction

`apps.json` is committed and CI builds from it. Entries pointing outside this
repository must carry `"optional": true` so a fresh clone still builds. Never
add a registry entry that requires network or a sibling checkout without it.

### Two build modes, one document

Every page renders through `src/layouts/Base.astro`. Headless (web-fragment) and
standalone differ only by `data-mp-headless` and the shadow-DOM compat styles —
not by a different layout. Changes that add a mode-specific code path need a
strong reason.

### Light only

The marketplace has no dark mode: no theme toggle, no persisted theme, no `dark`
class, no dark palette. `src/utils/transform.js` actively strips a sub-app's
theme bootstrap and `dark` body class. Do not reintroduce any of it.

### Sub-app HTML is untrusted input

Artifacts come from other repositories' releases. Treat their HTML, CSS and
archive contents as attacker-controlled: no unvalidated archive extraction, no
unsanitised HTML re-hosting, no shell interpolation of registry values.

### Portability

The build runs on Linux CI and on Windows developer machines. Prefer Node APIs
(`cpSync`, `rmSync`) over shelling out to `cp`/`rm`. Where `tar` is unavoidable,
follow the drive-letter workaround documented in
`scripts/build-vite.js` (`stageArtifact`).

### Contract changes

`contract/` is the public API for onboarding repositories. Changing
`schema.json`, `HEADLESS_RULES.md`, `STYLE_GUIDE.md` or `SINGLE_PAGE.md` is a
breaking change for every doc app — call it out explicitly in the PR
description.

### Pinning

Every GitHub Action is pinned to a commit SHA with the version in a trailing
comment. Keep it that way; Dependabot bumps them.

## Aggregated PRs

Grouping related issues into one PR is fine and often better than a chain of
one-line PRs. When doing so:

- Group by **subsystem**, not by severity — reviewers read one area at a time.
- Reference every issue with its own `Closes #N` line.
- Keep the diff under the 50-file limit.
- Do not mix a security fix with an unrelated refactor; a reviewer should be
  able to reason about the security change in isolation.
