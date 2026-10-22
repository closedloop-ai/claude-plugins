---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, main-failures]
---

This is a rehearsal of one step of a vibe session's handoff, with no real
environment. Load the instructions with the Skill tool (`vibe:handoff`) and
decide your next step exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened, including the output of every script
you would have run.

Session state:
- App session `projects-board-chips`, live ticket ISS-4321, branch `vibe/projects-board-chips`. The person said "that's everything, can you raise a PR", so handoff ends with a pull request she takes through review and merge.
- Handoff steps 1 to 6 are done: the reviews passed and the writer's own fixes are committed.
- In step 7 the SAME writer just ran `main-sync-validate` with handoff purpose. It refused:
  `{"ok":false,"status":"BLOCKED","error":"Required validation command failed: pnpm turbo test --filter=...[9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b] --continue; it passes on captured main 4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39 and failed again on a rerun of the session commit, so the session caused it (session-caused); private logs <three log paths>"}`
- The first error line of the session's run reads: `FAIL apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts > every host passes the chip filter props`.

The person has not said anything new.

Answer in exactly this form, and nothing else:
NEXT: <one of: continue-handoff | send-to-writer-to-fix | ask-person | stop-handoff>
TICKET: <the one line you would have the ticket worker add to the live ticket for this check, word for word, or NONE>
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
