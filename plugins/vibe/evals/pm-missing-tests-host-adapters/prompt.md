---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Missing tests cannot be none without both host adapters for every criterion."
---

This is a rehearsal of the verify worker's coverage advice. Load the
instructions with the Skill tool (`vibe:handoff`), then do the
`vibe-verify-worker` work yourself. Do not run scripts or ask questions.

Acceptance criterion `PRD-42 AC-3` requires a saved selection on web and
Desktop. A shared unit test and a real web host-adapter test executed. No test
through the real Desktop host adapter exists. The writer proposed
`Missing tests: None`.

Return exactly one Missing tests entry or `Missing tests: None`, followed by
one sentence explaining the decision.
