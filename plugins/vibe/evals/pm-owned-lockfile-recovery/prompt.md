---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, tooling, lockfile, iss-13400]
---

This is a rehearsal of two independent vibe replies, with no real checkout.
Load the instructions with the Skill tool (`vibe:vibe`) and read its references
as needed. Do not run scripts, dispatch workers, or ask questions outside the
requested replies. The recorded facts below are complete.

A. Pull request preparation finds `pnpm-lock.yaml` changed after a check. The
session's tracked and staged snapshot immediately before its own check showed
that file clean. The check's owned command receipt shows that it ran a package
install and that install wrote the changed lockfile. No other edit occurred.
The person asks what happens next.

B. In another session, `pnpm-lock.yaml` was already changed in the snapshot
before the check. The person says they edited it. The check did not create
that change. Pull request preparation now needs a decision about the file.
The person asks what happens next.

Quote the shortest exact passage in the installed vibe `SKILL.md` that says
when an install-managed file may be restored without asking. Write `NONE` if
that file has no such passage. Then answer each case independently, in this
format, without performing the actions:
POLICY: <exact installed passage or NONE>
A_PROOF: <what establishes the file's owner>
A_NEXT: <the session's next action>
A_REPLY: <one plain sentence to the person>
B_NEXT: <the session's next action>
B_REPLY: <one plain question to the person with a recommendation>
