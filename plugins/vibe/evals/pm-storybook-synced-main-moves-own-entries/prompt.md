---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, storybook]
---

This is a rehearsal of one Storybook decision in a vibe session at handoff,
with no real environment. Load the instructions with the Skill tool
(`vibe:handoff`) and decide exactly as those instructions say. You may Read
the plugin's own reference and agent files. Do not run scripts, dispatch
workers or call any other tool, and do not ask me about the environment: the
session state below is everything that has already happened.

Session state:
- App session `grouped-list-sections`, seeded data, live ticket ISS-4410, branch `vibe/grouped-list-sections`.
- The session started on a main older than symphony-alpha #8867. On that base the writer added one new story file, `packages/app/documents/components/table/documents-view.stories.tsx`, with `title: "Composites v2.0/Shared/Artifact List/Documents View"` and `tags: ["autodocs", "v2.0"]`. That file is not on main.
- Handoff just synced main, which now includes #8867 (Storybook 3.0.0, the lifecycle scheme): the `v2.0` roots are now the plain roots, the old plain roots are now `<Level> v1.0`, and every story file carries one lifecycle tag. The merge is committed.
- `pnpm --filter storybook validate:catalog` now fails on that one file: its title root `Composites v2.0` is not a root, and its meta has no lifecycle tag.
- The Documents View is a section of shipped list pages in the live app.

Decide what the writer does to that story file. Answer in exactly this form, and nothing else:
TITLE: <the file's meta title after the fix>
TAGS: <the file's meta tags after the fix, comma-separated>
RECORD_AS_REPLACEMENT: <yes or no: does this change need `vibe-sessions.mjs story-replacement` before handoff can pass>
WHY: <one sentence>
