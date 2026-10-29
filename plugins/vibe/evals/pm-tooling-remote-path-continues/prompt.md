---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, tooling, alternative-path, iss-13400]
---

This is a rehearsal of one vibe reply, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and read its references as needed. Do not run
scripts, dispatch workers, or ask questions. The state below contains all
results you need.

A local visual checker cannot complete because its local runner exits before
the check starts. The same selected check has a supported remote lane, and
the source change is already saved. No remote run has been attempted yet.
The person asks, "What happens next?"

Reply in exactly this form:
NEXT: <use-remote-lane or stop-for-engineering>
REPLY: <one plain sentence to the person>
