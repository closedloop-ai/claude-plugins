---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, storybook]
description: "At placement, a planned story name that claims more than its planned play asserts is flagged before the story is written."
---

This is a rehearsal of one Storybook placement step in a vibe session, with no
real environment. Load the instructions with the Skill tool (`vibe:vibe`),
then do the `vibe-storybook-decomposer` agent's `placement` mode work yourself
in this context, exactly as the plugin's `agents/vibe-storybook-decomposer.md`
says. You may Read the plugin's own reference and agent files. Do not run
scripts, dispatch workers or call any other tool, and do not ask me about the
environment: the session state below is everything that has already
happened, including the output of every command you would have run.

Session state:
- App session `project-list-columns`, seeded data, live ticket ISS-4630, branch `vibe/project-list-columns`.
- The writer returned `NEEDS_STORYBOOK` before creating a new story file `packages/app/projects/components/project-artifact-list-columns.stories.tsx`, titled `Composites/Your Teams/Project Detail/Project Artifact List Columns`, for the shared project artifact list. The list shows four artifact kinds: PRD, Issue, Plan and Branch rows.
- Precedent search found the existing story file `packages/app/projects/components/project-artifact-list.stories.tsx` for the same component; owner, root and tag are settled and are not part of this question.
- The writer's planned stories and the play each will run:
  1. `Default`: renders the list with one row of each kind; its play asserts each row's name is visible.
  2. `Priority Label On Every Kind`: its play asserts the painted priority word ("Urgent", "High", "Medium") is visible on the PRD, Issue and Plan rows. It asserts nothing on the Branch row.
  3. `Branch Status From Pull Request State`: branch rows whose pull requests are open, merged and closed; its play asserts only that none of those rows shows the word "Unknown". It never asserts which status label each row paints.
  4. `Options Menu Lists Built In Columns`: its play opens the Options menu and asserts each built-in column name appears in it once.

Answer with the Placement block's Names line only, as one line per planned
story in exactly this form and nothing else:
<story name> | <ok|narrow|complete> | <each claim in the name with no planned assertion behind it, or ->
