---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, version-check]
description: "A resumed session reports an update and continues."
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
the next route. Do not run scripts, dispatch workers or call any other tool.

Session state:

- The person said: "/vibe:vibe resume PRD-900".
- The matching session is already active and selected.
- The version check returned installed 1.0.57 and latest 1.0.58.

Answer in exactly this form:
REPLY: <the version notice only>
ROUTE: <continue-session or ask-keep-going-or-update>
---
