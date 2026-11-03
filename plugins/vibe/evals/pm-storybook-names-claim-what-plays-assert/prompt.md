---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, storybook]
description: "Before a story is written, the placement block names the assertion each planned story name needs, so a name that claims more is caught early."
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
- Precedent search found the existing story file `packages/app/projects/components/project-artifact-list.stories.tsx` (title `Composites/Your Teams/Project Detail/Project Artifact List`, tag `stable`) for the same component, `packages/app/projects/components/project-artifact-list.tsx`, which the Project Detail page renders directly. No sibling entity has a column-controls story. The new file is titled and tagged by TAXONOMY.md like its sibling; there is no conflict.
- The writer plans four stories in the new file, named `Default`, `Priority Label On Every Kind`, `Branch Status From Pull Request State` and `Options Menu Lists Built In Columns`. Nothing is written yet: no story body or play exists.
- The fixture rows: one PRD (priority Urgent), one Issue (High), one Plan (Medium), and three Branch rows whose pull requests are open, merged and closed. Branch rows carry no priority. The list paints a branch row's status from its pull request state.

Return your Placement block exactly in the form the agent file gives, and
nothing else.
