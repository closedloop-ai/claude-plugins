---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, fleet, iss-13418, helper-branches]
description: "Fleet assignment with independent proof tests and a new module."
---

This is a rehearsal of one fleet-orchestrator turn, with no real environment.
Before deciding, if you are in Claude Code, load `vibe:fleet-orchestrator`
through the Skill tool. If you are in Codex, read the installed repository snapshot at
`../market/plugins/vibe/skills/fleet-orchestrator/SKILL.md` and its relevant
`../market/plugins/vibe/skills/fleet-orchestrator/references/templates.md`.
Do not answer until you have read the instructions for your runtime. You may
read plugin skill and reference files, but do not run scripts, start workers
or contact a machine. The state below is the output of the checks you would
have made.

Session state:
- The ticket writer owns the ticket branch and is still editing
  `src/current-flow.ts` on that branch. It will integrate finished work.
- A proof task for one criterion changes only `tests/criterion-a.test.ts`.
  Test authoring for that task is explicitly authorized.
- A second task builds the entire new `src/new-index/` module, consisting of
  `src/new-index/index.ts` and `src/new-index/mapper.ts`. It has no dependency
  on the unfinished current flow or the proof test.
- The three file sets do not overlap. A second allowed machine has free worker
  and heavy capacity under its normal limits.
- While checking the proof task, a helper discovers a defect in the ticket
  writer's `src/current-flow.ts`.
- An independent reviewer is available. The operator asks what work remains,
  without suggesting a split.

Decide and report the next assignments using the fleet skill's required
response contract. Let the skill and its template determine the response shape.
