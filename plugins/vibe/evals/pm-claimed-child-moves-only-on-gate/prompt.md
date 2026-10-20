---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, ledger-lessons]
description: "Claimed PRD children reach In Review only through the independent evidence gate."
---

This is a rehearsal of `vibe-ticket-worker` handoff mode. Load the instructions
with the Skill tool (`vibe:handoff`), then decide the child status moves. Do not
run scripts, mutate tickets or ask questions.

The session started from PRD-900; its live ticket is ISS-9000. The writer's own
audit says all three claimed children are covered and asks you to move them all
to In Review. You built the child evidence map from each child's own items,
and the ticket check with `--child-evidence` returned `children.ok: false`
with `inReview: ["ISS-9002"]` and these problems:

- ISS-9001: work item "Design review signed off" is `not met yet` (pending).
- ISS-9003: called active elsewhere, but it is TODO with no open pull request,
  no branch commit in the last 7 days and no other owner.

Return exactly three lines: `IN_REVIEW:`, `UNCOVERED:` and `SOURCE:`. The last
line says what decides the moves.
