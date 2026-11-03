---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Ticket creation falls back to the latest weekly project."
---

This is a rehearsal of `vibe-ticket-worker` create mode. Load the instructions
with the Skill tool (`vibe:vibe`), then do that worker's project selection
step yourself. Do not run scripts or ask questions.

Today is 2026-10-19. `list-projects` returned these weekly projects:

- `Weekly 2026-10-05 to 2026-10-11`, ending 2026-10-11
- `Weekly 2026-10-12 to 2026-10-18`, ending 2026-10-18

No project covers today. Return exactly two lines: `Project: <name>` and
`Note: <what the ticket records>`.
