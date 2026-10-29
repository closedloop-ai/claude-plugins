---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, tooling, next-step, iss-13400]
---

This is a rehearsal of one vibe reply, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and read its references as needed. Do not run
scripts, dispatch workers, or ask questions. The state below contains all
results you need.

The local check is unavailable. A supported remote lane can run it, and the
session has the saved work needed to submit that run. The person says,
"I am the engineer. What's next?"

Reply in exactly this form:
NEXT: <start-remote-check or refer-to-engineering>
REPLY: <one plain sentence to the person>
