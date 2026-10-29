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

Consider three independent saved vibe sessions. In each one, the writer
returned `BLOCKED`, the ledger still says `BLOCKED`, and the ticket records
an engineering referral. Each stop cites this guardrail text: "When
continuing needs a fix to the vibe tooling, stop." The person then says,
"I am the engineer, what's next?" No action has happened since the stop.

A. A local checker exited before it started. The exact invocation was never
tried again. The failure happened before check selection, so there is no
smaller local check to select. The checked work is saved.

B. A broad local check failed twice with the same tooling error. Its selected
subset can run separately, but nobody tried that narrower invocation. The
checked work is saved.

C. This machine cannot launch the selected check. The checked commit is
pushed, and the normal automatic validation for that commit includes the
same selected check. No result for that check exists yet.

Quote the shortest exact passage in the installed vibe `SKILL.md` that states
when an engineering referral is allowed. Write `NONE` if that file contains
no such passage. Then answer for A, B, and C separately, in this exact order
and format. Describe the decision without running tools, changing records,
or asking questions:
POLICY: <exact installed passage or NONE>
A_NEXT: <the session's next action in a few words>
A_RECORD: <what happens to the recorded stop and referral>
A_REPLY: <one plain sentence to the person>
B_NEXT: <the session's next action in a few words>
B_RECORD: <what happens to the recorded stop and referral>
B_REPLY: <one plain sentence to the person>
C_NEXT: <the session's next action in a few words>
C_RECORD: <what happens to the recorded stop and referral>
C_REPLY: <one plain sentence to the person>
