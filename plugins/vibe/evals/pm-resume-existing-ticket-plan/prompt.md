---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, plan-links, resume, iss-13411]
description: "A resumed ticket with no PLN publishes one without pausing the build, while a ticket with one reuses it."
---

Rehearse two independent resumed sessions. Load `vibe:vibe`; do not run tools
or ask questions. State what happens before each resumed request.

Session MISSING:
- ISS-14001 has a criterion-complete canonical local plan.
- The session record has no `livePlan`.
- Listing outgoing ticket `PRODUCES` links returns no PLN.

Session EXISTING:
- ISS-14002 produces current plan PLN-1450.
- The session record has no `livePlan` because an older run stopped before
  recording it.

Reply exactly:
MISSING: <plan and link action>
EXISTING: <plan action, including whether a new PLN is created>
BUILD: <whether plan reconciliation pauses either source build>
