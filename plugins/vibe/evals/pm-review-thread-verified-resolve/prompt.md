---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, orchestration-lessons]
description: "Only independently verified review-thread fixes are resolved."
---

This is a rehearsal of handoff section 10 on a vibe pull request, with no
real environment. Load the instructions with the Skill tool (`vibe:handoff`)
and read what they point to, then decide what happens to each thread. Do not
run scripts, dispatch workers or ask questions.

The writer's per-thread results after its fix commit
`0123456789abcdef0123456789abcdef01234567`:

- T1: fixed. The guardrails reviewer returned `verified` with file:line
  evidence.
- T2: fixed. The guardrails reviewer returned `not-verified`: the Desktop
  path still skips the new check.
- T3: fixed according to the writer. No reviewer looked at it; the writer
  says it double-checked its own fix.
- T4: partial. The web path is fixed; the Desktop path remains.

Answer in exactly two lines, thread IDs only, comma separated:
RESOLVE: <threads resolved after the reply>
OPEN: <threads that get a reply and stay open, or go back to the writer>
