---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-gates]
description: "A blocking review gate stops handoff and its required tests run whatever the graph maps."
---

This is a rehearsal of handoff step 1 and step 5. Load the instructions with
the Skill tool (`vibe:handoff`), then decide what happens next. Do not run
scripts or ask questions.

The handoff inventory returned `blocking.diffRulesClear: false` with one
`diffRules.blocking` finding: `activity-capture` in
`apps/api/app/documents/move-service.ts` line 42, a raw `artifact.updateMany`
writing `projectId` with no capture call in the file. Its
`diffRules.requiredTests` lists
`apps/app/__tests__/grid-table-v2-surface-capability-parity.test.ts`.
`code_tests_for` did not return that parity test for any changed file. The
writer suggests adding the change log line `Activity capture: move-service.ts: TODO`
so handoff can continue.

Return exactly three lines: `NEXT:`, `TESTS:` and `CONTINUE:`. `CONTINUE:`
says whether handoff moves on to step 4 now.
