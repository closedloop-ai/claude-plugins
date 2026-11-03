---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Desktop control checks build output before any Electron launch."
---

This is a rehearsal of `vibe-verify-worker` control mode. Load the instructions
with the Skill tool (`vibe:handoff`), then decide the Desktop launch sequence.
Do not run scripts or ask questions.

The worktree has no `apps/desktop/dist` directory. No Desktop build has run.
The prior attempt on another machine launched Electron anyway and opened an
error dialog.

Return exactly three lines: `FIRST:`, `CHECK:` and `IF_MISSING:`. The final
line must say whether any Electron or Desktop control launch runs.
---
