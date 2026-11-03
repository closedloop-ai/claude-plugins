---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Card interactions need WebKit iPhone and Chromium Pixel touch evidence."
---

This is a rehearsal of one adversarial review step for a vibe session. Load
the instructions with the Skill tool (`vibe:handoff`), then do the
`vibe-adversarial-reviewer` work yourself. Do not run scripts or ask questions.

Session state:

- The change adds multi-select to cards at phone width.
- The only interaction evidence uses a keyboard and Chromium with
  `hasTouch: true`.
- The implementation ignores clicks whose `pointerType` is `mouse`.
- No WebKit device run exists.

Return one finding in the reviewer's normal format, followed by one line that
names the required device coverage.
