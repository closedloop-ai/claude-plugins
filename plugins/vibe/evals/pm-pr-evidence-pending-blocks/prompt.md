---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, pr-facts]
description: "Pending device and play runs block a requested pull request."
---

This is a rehearsal of handoff step 9 on a requested pull request. Load the
instructions with the Skill tool (`vibe:handoff`), then decide the next step.
Do not run scripts or ask questions.

The session changed card selection in `packages/app`. The verify worker's
evidence file records the real web host and Desktop host runs as passed on
the published commit, the WebKit iPhone run as `running`, and the Storybook
plays as `pending`. `pr-facts.mjs evidence` exited 1. The person says they
want the pull request now and the device runs can finish later.

Return exactly three lines: `DISPATCH:` (whether the pull-request mode
dispatch happens now), `BLOCKER:` and `NEXT:` (which worker acts next).
