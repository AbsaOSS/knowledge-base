# Contributing

Thanks for your interest in improving **knowledge-base**.

## Development setup

```bash
npm install            # Node >= 24
npm run build:headless # hermetic build from the vendored fixture (tests/fixtures/)
npm test               # embedded web-fragment E2E (Playwright)
```

The build and tests are fully hermetic — they use the committed
`tests/fixtures/docs-example.dist.tar.gz` fixture (registered via `apps.json`),
so no `GITHUB_TOKEN`, network, or sibling repository is required.

See [`CLAUDE.md`](CLAUDE.md) for an architecture overview and the full command
list, and [`README.md`](README.md) for usage.

[`AGENTS.md`](AGENTS.md) is the mechanical checklist for what CI enforces on a
pull request — branch name, title format, description, size — plus the
repository conventions a change is expected to respect. Worth a read before
opening your first PR, and required reading for automated contributors.

## Tests

| Command | What it runs |
|---|---|
| `npm test` | Embedded web-fragment harness (`playwright.config.js`) — host gateway proxies/embeds the fragment on `:4201`. |
| `npx playwright test --config=playwright.config.ci.js` | Standalone fragment-server layer (`:3000`) — headers, headless contract, asset routing, #297. |

Both run in CI (`.github/workflows/ci.yml`). Please make sure both pass before
opening a PR.

## Pull requests

1. Branch off `master`.
2. Keep changes focused; update docs/tests alongside code.
3. Ensure `npm run build:headless`, `npm test`, and the standalone suite pass.
4. CI (type-check, build, E2E, audit) must be green.

## Reporting security issues

Please follow [`SECURITY.md`](SECURITY.md) — do not file public issues for
vulnerabilities.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
