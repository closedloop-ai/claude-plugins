---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, fleet, iss-13420]
description: "A terminal PR releases only its recorded QA stack and reports ownership."
---

This is a rehearsal of one fleet-orchestrator turn in Claude Code, with no real
environment. Load `vibe:fleet-orchestrator` and decide the next action from
the supplied state. You may read plugin skill and reference files. Do not run
scripts, start workers or contact a service.

Session state:
- The monitor reports PR 42 in acme/app has closed. Its ticket is ISS-13420.
- `helpers.json` records QA helper `qa-owned`, owner `writer-a`, ticket
  `ISS-13420`, PR 42, ending condition PR closure, PID birth identity, and
  exact container, volume and network creation witnesses for project `qa-owned`.
- A different worker's stack `qa-foreign` is running. It has no record in this
  program and belongs to another ticket.
- The operator asks for fleet status. Nobody has requested a cleanup action.

Reply in exactly this form, and nothing else:
ACTION: <what happens now to the recorded QA helper>
DOCKER: <what happens to its recorded container, volumes and network>
FOREIGN: <what happens to the other worker's stack>
STATUS: <what the fleet status reports, including owner and ticket>
