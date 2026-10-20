---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, orchestration-lessons]
description: "A Codex writer stopped by its usage limit moves to Claude through the ledger."
---

This is a rehearsal of the vibe orchestrator (ROOT) in one session, with no
real environment. Load the instructions with the Skill tool (`vibe:vibe`) and
read what they point to, then decide what ROOT does. Do not run scripts,
dispatch workers or ask questions.

Session state:

- The session's persistent writer is a Codex native worker, recorded in the
  writer ledger with runtime `codex`.
- Its current turn ended with the error "You've hit your usage limit. Try
  again in 4 days." and the turn has stopped. The active request is half
  built; its plan, decision table and change log are on disk.
- The `claude` CLI is installed and signed in on this Mac.
- Last time this happened, a Claude worker was told to finish the change
  directly and the session records never learned about it.

Answer in exactly three lines:
FINISH: <how ROOT closes the dead turn in the ledger>
MOVE: <the command and the input field that moves the writer>
NEVER: <what ROOT must not do>
