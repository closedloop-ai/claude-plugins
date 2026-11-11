---
name: closedloop-provider
description: The ClosedLoop and symphony-alpha knowledge vibe and fleet-orchestrator follow while this plugin is enabled (ClosedLoop tickets and plans, closedloop-graph, repository memory, and the symphony-alpha recipes). vibe and fleet read it themselves; never start it on its own. Disable the plugin to run vibe and fleet generically.
---

# ClosedLoop provider for vibe and fleet

This plugin is vibe's optional provider. vibe and fleet-orchestrator run in any
repository without it. While it is enabled, a vibe or fleet start binds it
(`plugin-version.mjs check` records the binding for the conversation and the
session), and from then on they follow its text and data in place of their
generic steps.

Nothing here runs on its own. vibe reads it only through
`skills/vibe/scripts/provider.mjs` in the vibe plugin, which answers only for a
bound session:

- `provider.mjs block <capability> <file> <id>` prints one block of a file in
  `references/`. A line in a vibe skill, reference or agent of the form
  ``> Provider `<capability>` (block `<id>` of `<file>`)`` stands for that block.
- `provider.mjs data <capability> <key>` prints one value of `provider.json`'s
  `data`.
- `provider.mjs path <capability> provider:<file>` prints where a whole
  reference here is (`closedloop-graph.md`, `ticket-template.md`).

Paths inside these references that start with `references/` or `scripts/` are
vibe's, relative to the vibe skill folder the text extends (or `../` from vibe's
`agents` folder, as in the agent file it extends); `provider:<file>` names a
file in this skill's `references` folder.

Capabilities, and what each needs before it binds (`provider.json`):

| Capability | What it adds | Needs |
|---|---|---|
| `tickets` | the live ClosedLoop ticket, its template, statuses, assignees, comments, rulings and ticket units | ClosedLoop `get-me` answered in the conversation |
| `plans` | the PLN document, its links and approval | the same |
| `graph` | closedloop-graph research, the Graph block, collisions and test lookups | closedloop-graph `sync_status` answered |
| `memory` | `workflow-memory` queries | nothing more; each query is made only when the command exists |
| `recipes` | symphony-alpha's commands, paths, environments, e2e harnesses, PR body sections, repo-owned review gates, diff rules, main-sync check matrix, and the `.closedloop-ai/` plan and decision-table folders | the repository commits `.closedloop-ai/vibe-recipes.json` |

To turn it off, disable the plugin (`claude plugin disable vibe-closedloop-provider@closedloop-ai`
in Claude Code, or set `enabled = false` under `[plugins."vibe-closedloop-provider@closedloop-ai"]`
in Codex's `config.toml`). vibe never turns it back on.
