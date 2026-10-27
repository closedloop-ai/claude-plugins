---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, storybook]
description: "A new story whose surface sits behind a flag that is off in the production flag snapshot is tagged preview at placement, wherever it lives."
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
- App session `project-list-columns`, seeded data, live ticket ISS-4631, branch `vibe/project-list-columns`, on the lifecycle Storybook scheme (`stable`, `preview`, `experimental`, `deprecated`).
- The writer returned `NEEDS_STORYBOOK` before creating a new story file `packages/app/projects/components/project-artifact-list-columns.stories.tsx` for the project artifact list's column controls. Its title is settled: `Composites/Your Teams/Project Detail/Project Artifact List Columns`.
- The Project Detail page renders this list only when the PostHog flag `projects-portable-surface` is on; with it off, the live app shows the older Project Detail list. The planned stories turn on `gridview-adoption` and `manual-artifact-ordering` in `parameters.appCore.enabledFlags`.
- `vibe-sessions.mjs show` lists `flagSnapshot.file`, and that file reads: `{ "takenAt": "2026-10-27T15:00:00Z", "flags": { "projects-portable-surface": false, "gridview-adoption": true, "manual-artifact-ordering": true } }`.
- The sibling story file `packages/app/projects/components/project-artifact-list.stories.tsx` is the precedent; there is no other conflict.

Decide the new story file's lifecycle tag. Answer in exactly this form, and nothing else:
TAG: <the one lifecycle tag in the new file's meta>
WHY: <one sentence>
