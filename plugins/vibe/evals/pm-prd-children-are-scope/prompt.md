---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, ticket-lessons]
description: "Existing PRD children are claimed or reported, never agent-superseded."
---

This is a rehearsal of `vibe-ticket-worker` create mode. Load the instructions
with the Skill tool (`vibe:vibe`), then decide the child-ticket actions. Do not
run scripts, mutate tickets or ask questions.

The session started from PRD-900. Its new coordinating ticket is ISS-9000 and
the session operator has id `operator-1`.

- ISS-9001 is TODO, unassigned, has no branch, pull request or progress comment,
  and its exact outcome is in the request.
- ISS-9002 is IN_PROGRESS, assigned to another account, has a branch and recent
  progress comments, and its exact outcome overlaps the request.
- ISS-9003 is TODO and untouched, but its outcome is not in the request.

Return exactly four lines: `CLAIM:`, `REPORT:`, `UNCOVERED:` and `SUPERSEDE:`.
---
