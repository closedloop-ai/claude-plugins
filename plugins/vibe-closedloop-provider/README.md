# vibe-closedloop-provider

The ClosedLoop provider for vibe and fleet-orchestrator. vibe and fleet run in
any git repository without it. It is not installed as a plugin of its own: it
is an input to the ClosedLoop build of vibe, published as `vibe`. In that
build, a vibe or fleet start binds it, and the session also:

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
(`provider.json`). That file holds exactly
`{"schema": 1, "provider": "vibe-closedloop-provider"}`; a missing or
malformed one binds the other capabilities and withholds `recipes` with one
named reason. A session started without the provider
stays generic until it ends. The folder holds text and data only: no hooks and
no scripts. vibe-core's one guard engine reads its rules.

## The build

`tools/vibe-closedloop-build` (`npm run build`) writes `plugins/vibe-closedloop`
from `plugins/vibe` and this folder. It assembles every provider block into the
vibe text it belongs to, copies `provider.json` and the references into the
built plugin's `provider/` folder, and applies `build.json`: the manifest and
frontmatter descriptions, the sections moved to cold files with their pointer
line, the line that marks recipe text, and the files the provider replaces
whole. Never edit `plugins/vibe-closedloop` by hand; change `plugins/vibe` or
this folder and rebuild. Install the build as `vibe@closedloop-ai`; to run vibe with
no provider, install `vibe-generic@closedloop-ai`, which is `plugins/vibe` as
it stands.

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
