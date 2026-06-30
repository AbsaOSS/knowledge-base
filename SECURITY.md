# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's [private vulnerability reporting](https://github.com/AbsaOSS/knowledge-base/security/advisories/new)
(Security → Advisories → "Report a vulnerability"). If that is unavailable, email
the maintainers at **opensource@absa.africa**.

Include where possible:
- A description of the issue and its impact
- Steps to reproduce (or a proof of concept)
- Affected version / commit
- Any suggested remediation

We aim to acknowledge reports within **5 business days** and to provide a
remediation timeline after triage. Please allow us a reasonable period to
release a fix before any public disclosure.

## Scope

This project is a **build-time aggregator** that downloads pre-built static doc
artifacts and serves them via nginx. Areas of particular interest:

- The artifact fetch pipeline (`scripts/fetch-apps.js`) — it downloads and
  extracts third-party `dist.tar.gz` archives.
- The HTML transform/URL-rewriting (`src/utils/transform.js`).
- nginx response headers (`nginx.conf`).
- The reusable `validate-doc-app.yml` workflow, which runs against third-party
  doc repositories.

Note that `apps.json` (the registry of source repositories) is maintainer-
controlled; only trusted repositories should be added.

## Supported Versions

Security fixes are applied to the latest release on the default branch
(`master`). Older versions are not maintained.
