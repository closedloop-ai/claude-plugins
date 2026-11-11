# vibe-closedloop-provider

The optional ClosedLoop provider for vibe and fleet-orchestrator. vibe and fleet
run in any git repository without it. With this plugin installed and enabled,
a vibe or fleet start binds it, and the session also:

- keeps a live ClosedLoop ticket for the work, publishes the session plan as a
  linked PLN, and hands the ticket to the next owner (`tickets`, `plans`);
- researches with closedloop-graph and queries repository memory with
  `workflow-memory` (`graph`, `memory`);
- in a repository that commits `.closedloop-ai/vibe-recipes.json` (today,
  symphony-alpha), runs that repository's recipes: its bootstrap, per-session
  Vercel environments with seeded or blank data and a production flag snapshot,
  its Storybook, e2e harnesses, diff rules, PR body sections, its own review
  gates and its main-sync check matrix, with plans and decision tables under
  `.closedloop-ai/` (`recipes`).

Each capability binds only when what it needs holds in that chat: the ClosedLoop
connection answered for `tickets` and `plans`, closedloop-graph answered for
`graph`, and the committed opt-in file for `recipes`
(`skills/closedloop-provider/SKILL.md`). That file holds exactly
`{"schema": 1, "provider": "vibe-closedloop-provider"}`; a missing or
malformed one binds the other capabilities and withholds `recipes` with one
named reason. A session started without the provider
stays generic until it ends. The plugin ships text and data only: no hooks and
no scripts. vibe-core's one guard engine reads its rules.

## Installation

```bash
claude plugin install vibe-closedloop-provider@closedloop-ai
codex plugin add vibe-closedloop-provider@closedloop-ai
```

Disable or uninstall it to run vibe generically; vibe never re-enables or
reinstalls it.

## The main-sync recipe

`data.recipes.mainSync` is the check matrix vibe's main sync runs before every
publication in that repository, with its generated inputs, retained reports,
lane discovery, Desktop lane and CI producer. The matrix follows operator
rulings:

- 2026-10-13: a build-loop deploy runs only what the commit hooks run (Biome on
  the changed source and the affected typecheck); the suites run at handoff.
- 2026-10-19: no broad or full local suite runs in main sync. The verify worker
  runs the tests the graph selects per changed file, and CI runs the broad
  suites on the PR and after merge.
- 2026-10-28: the pinned typecheck covers the session's own diff against the
  main it captured, so a main merge never widens it by main's own changes.

Without a provider recipe, main sync runs no checks in the build loop and, at
handoff, the test command the repository's AGENTS.md documents.
