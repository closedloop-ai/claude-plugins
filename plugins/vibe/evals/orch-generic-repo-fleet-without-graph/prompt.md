---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, generic-walk, generic]
---

This is a read-only rehearsal. Load (`vibe:fleet-orchestrator`). Do not run
scripts or mutate anything.

Program state:
- The operator runs the fleet on their own GitHub repository. No provider is
  bound: no tracker, no graph service, no repository memory.
- The operator asked for two independent changes: a CSV export button and a
  fix for a date formatting bug. There are no tickets; the operator described
  both in chat.

Answer exactly:
UNITS: <how the two pieces of work are named and tracked>
RESEARCH: <what research each writer brief carries, and where it comes from>
BLOCKERS: <anything missing that stops the program, or "none">
