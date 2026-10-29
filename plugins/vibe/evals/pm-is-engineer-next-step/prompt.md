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

The last reply said, "The checker is broken, so this needs an engineer."
That reply came after a local attempt exited before validation started. The
saved work has an exact commit, and the existing automatic CI job accepts
that commit for the same check. Nobody has requested that run yet. The person
says, "I am the engineer. What's next?"

Reply in exactly this form:
NEXT: <the session's next action in a few words>
REPLY: <one plain sentence to the person>
