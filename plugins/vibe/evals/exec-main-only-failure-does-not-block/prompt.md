---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [exec, main-failures]
---

This is a rehearsal of one step of a vibe session's handoff, with no real
environment. Load the instructions with the Skill tool (`vibe:handoff`) and
decide your next step exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened, including the output of every script
you would have run.

Session state:
- App session `board-scanning`, live ticket ISS-5150, branch `vibe/board-scanning`. The person is an executive. They asked to pass the work on to design, and the lookup resolved exactly one user.
- Handoff steps 1 to 6 are done: the reviews passed and the writer's own fixes are committed.
- In step 7 the SAME writer just ran `main-sync-validate` with handoff purpose. The script printed:
  `{"status":"DONE","publicationReady":true,"requiredE2eComplete":true,"mainSha":"4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39","commandCount":11,"mainPreexistingFailures":[{"check":"pnpm check:source-gates","mainSha":"4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39","sessionExitCode":1,"mainExitCode":1,"mainArgv":["pnpm","check:source-gates"]}]}`
- The writer's turn then returned: `BLOCKED: pnpm check:source-gates fails with "api path filter: apps/api/routes/health.ts is not matched by the api path filter". The session never touched that file or the filter. A needed fix stops the handoff.`
- The first error line of that check's run on the captured main is the same api path filter line.

The person has not said anything new.

Answer in exactly this form, and nothing else:
NEXT: <one of: continue-handoff | send-to-writer-to-fix | ask-person | stop-handoff>
TICKET: <the one line you would have the ticket worker add to the live ticket for this check, word for word, or NONE>
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
