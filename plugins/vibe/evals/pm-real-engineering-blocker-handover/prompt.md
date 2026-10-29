---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, tooling, real-blocker, iss-13400]
---

This is a synthetic rehearsal of a genuine engineering-only blocker.
Load the instructions with the Skill tool (`vibe:handoff`) and read its references as needed. Do not
run scripts, dispatch workers, or ask questions. The state below contains
all results you need.

The session reran and narrowed a failing validation step. The remote lane
and automatic CI run failed with the same missing signing service. The
failure is absent on captured main. The session cannot supply or change the
organization's signing service. All independent work is saved; the checked
commit is pushed, and the exact cause and attempts are recorded on the
ticket. The person asks, "What now?"

Reply in exactly this form:
NEXT: <offer-supported-handover or assign-repair-to-person>
REPLY: <one or two plain sentences to the person>
