# Agent skills

Skills this repository publishes for AI coding agents. Each is a directory with a
`SKILL.md` following the [Agent Skills](https://agentskills.io/specification) format,
so the same files load in Claude Code, GitHub Copilot, and any other agent that reads
`SKILL.md`.

| Skill | What it does |
|---|---|
| [`kb-docs-add`](./kb-docs-add) | Onboards a repository's documentation into the knowledge base: picks single-page / packaged / iframe, writes only the files the contract requires, and maps every publishing error to its fix |

## Install

With the [`skills`](https://github.com/vercel-labs/skills) CLI, which discovers
`skills/*/SKILL.md` in this repo and installs into the agent directories you pick:

```bash
# interactive: choose agents and scope
npx skills add AbsaOSS/knowledge-base --skill kb-docs-add

# non-interactive, project scope, named agents
npx skills add AbsaOSS/knowledge-base --skill kb-docs-add -a claude-code -a github-copilot -y

# user scope instead of the current project
npx skills add AbsaOSS/knowledge-base --skill kb-docs-add -g
```

Without the CLI, copy the skill directory to where your agent looks:

| Agent | Project | Personal |
|---|---|---|
| Claude Code | `.claude/skills/kb-docs-add/` | `~/.claude/skills/kb-docs-add/` |
| GitHub Copilot (cloud agent, CLI, VS Code) | `.github/skills/kb-docs-add/` — also reads `.claude/skills/` and `.agents/skills/` | `~/.copilot/skills/kb-docs-add/` |
| Anything on the open spec | `.agents/skills/kb-docs-add/` | `~/.agents/skills/kb-docs-add/` |

Then, in the docs repo you want to onboard, ask the agent to "add this repo's docs to
the knowledge base" — or `/kb-docs-add` where slash commands exist.

## Authoring rules

- **Guidance, not code.** The publishing actions in [`actions/`](../actions) own every
  check. A skill points the agent at them; it never ships a script that re-implements one.
  `tests/skill.spec.js` fails on any executable file under a skill.
- **Examples are the contract.** Files under `examples/` are byte-for-byte the code
  blocks in `contract/`, extracted by heading. Change the contract, then regenerate the
  example; the spec compares them.
- **Portable frontmatter only.** `name`, `description`, `license`, `metadata`. No
  `allowed-tools` — it is Claude-only and experimental, and a skill installed into
  `.github/skills/` must not depend on it.
- **`SKILL.md` stays short.** Under ~150 lines; anything longer moves to `references/`
  and is loaded when the agent needs it.
- **Evals** for `kb-docs-add` are in [`tests/fixtures/kb-docs-add/`](../tests/fixtures/kb-docs-add):
  three fixture repos and an `evals.json` with a prompt and assertions per case, in the
  shape the `skill-creator` tooling reads. They are not part of `npm test` — they need an
  agent to run — but the assertion "no files outside the allowed set" is the one that
  matters most when changing the skill's wording.
