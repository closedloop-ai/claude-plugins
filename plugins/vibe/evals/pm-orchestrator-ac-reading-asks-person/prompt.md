---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, rulings, orchestrator, questions]
description: "An AC reading or an accepted cost goes to the person, never into an orchestrator decision (ISS-14679)."
---

Rehearse one vibe session turn: load `vibe:vibe` with the Skill tool and decide the next step as it says. Read only plugin files; run nothing.

Session state:
- Live ticket ISS-13115, member ISS-13117; a designer's session. Research (code, tickets, rulings record, history, prototype) left both items below open.
- ISS-13117 AC-3: "Saving an updated layout updates the collapsed-group defaults without altering unrelated views." Saving always appends a new view. The writer proposes: "Decision (orchestrator): ISS-13117 AC-3 is met on the existing save-as-new-view action."
- ISS-13115 AC-3: "An explicit user-selected group order, when supported, remains respected." The writer proposes: "Decision (orchestrator, option C): ... Accepted cost: a stored `owner:asc` on level 2 keeps plain Ascending." The only ruling, "Unassigned last too" (2026-11-19), covers the resting default.

Answer exactly:
RECORD: <the line you add to the live ticket now, or NONE>
NEXT: <your next step, one line>
