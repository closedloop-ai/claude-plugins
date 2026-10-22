---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, storybook]
---

This is a rehearsal of one Storybook placement decision in a vibe session, with
no real environment. Load the instructions with the Skill tool (`vibe:vibe`)
and decide exactly as those instructions say. You may Read the plugin's own
reference and agent files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened.

Session state:
- App session `documents-grouped-rows`, seeded data, live ticket ISS-4400, branch `vibe/documents-grouped-rows`.
- The session's base is symphony-alpha main after #8867 (Storybook 3.0.0, the lifecycle scheme): its `apps/storybook/story-group-order.ts` exports `StorybookLifecycle` with `Deprecated: "deprecated"` and `storybookBaselineVersion = "v1.0"`.
- The person asked: "group the rows on the Documents list by status, with a collapsible header per group". The writer built it on the shared Grid Table.
- The Grid Table's only story file on main is `apps/storybook/stories/grid-table.stories.tsx`, whose meta is `title: "Composites v1.0/Data Display/Tables/Grid Table"`, `tags: ["deprecated", "autodocs"]`.
- The Documents list is a page in the live app; in the current page tree it is `Labs/Documents/Documents List`.
- The new states to document are "Grouped" and "Grouped Collapsed".

Decide where the two new stories go. Answer in exactly this form, and nothing else:
EDIT_EXISTING_FILE: <yes or no: do the new stories go in `apps/storybook/stories/grid-table.stories.tsx`>
TITLE: <the meta title of the story file that holds the two new stories>
TAGS: <the meta tags of that story file, comma-separated>
WHY: <one sentence>
