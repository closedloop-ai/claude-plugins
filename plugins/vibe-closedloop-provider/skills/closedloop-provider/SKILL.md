---
name: closedloop-provider
description: At vibe start, call ClosedLoop get-me and closedloop-graph sync_status first, then add --closedloop <state> --graph <state> to the check. The ClosedLoop and symphony-alpha knowledge vibe and fleet-orchestrator follow while this plugin is enabled (ClosedLoop tickets and plans, closedloop-graph, repository memory, and the symphony-alpha recipes). vibe and fleet read it themselves; never start it on its own. Disable the plugin to run vibe and fleet generically.
---

# ClosedLoop provider for vibe and fleet

This plugin is vibe's optional provider. vibe and fleet-orchestrator run in any
repository without it. While it is enabled, a vibe or fleet start binds it: the
start runs `plugin-version.mjs provider`, makes the two calls it names (the ones
this skill's description names), then runs `plugin-version.mjs check` with their
states, which records the binding for the conversation and the session and
writes the vibe text assembled for it. Each capability binds when its own needs
hold, so a connection that did not answer withholds only what needs it. From
then on they follow its text and data in place of their generic steps.

Nothing here runs on its own. vibe reads it only through
`skills/vibe/scripts/provider.mjs` in the vibe plugin, which answers only for a
bound session:

- `provider.mjs block <capability> <file> <id>` prints one block of a file in
  `references/`. A line in a vibe skill, reference or agent of the form
  ``> Provider `<capability>` (block `<id>` of `<file>`)`` stands for that block.
- `provider.mjs tree` prints the folder of vibe text the check assembled for
  this repository when it bound the provider (`references/provider-text.md` in
  the vibe skill).
- `provider.mjs assemble <file>` writes a vibe file with every block it serves
  in place, and `assemble --blocks <file>` only those blocks, for a file already
  read; each prints the path it wrote.
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
