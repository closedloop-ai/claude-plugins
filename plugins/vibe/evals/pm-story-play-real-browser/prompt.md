---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Story plays need awaited interactions and real browser evidence."
---

This is a rehearsal of the verify step for a vibe session, with no real
environment. Load the instructions with the Skill tool (`vibe:handoff`), then
do the `vibe-verify-worker` work yourself. Do not run scripts or ask questions.

Session state:

- A touched story has a `play` function with `userEvent.click(button)` and no
  `await`.
- Its jsdom story test passed.
- The story built successfully.
- No Storybook test runner or Playwright browser run was recorded.

Return exactly two lines. The first says whether the play evidence passes or
fails and why. The second names the evidence required before handoff.
