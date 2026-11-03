---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [exec, negative]
---

This is a rehearsal of one turn of a vibe session, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next
message to the person exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened.

Session state:
- App session `projects-board-chips`, seeded data, live ticket ISS-4321, branch `vibe/projects-board-chips`.
- Every request is built, deployed to the person's preview, and shown to them. Nothing is queued.
- Earlier requests, in the person's words: "add a due date column to the projects board", "make the overdue ones stand out".
- The person said they were done, and you replied with the question your instructions give for how the session ends.

The person just said: "oh i thought you were going to code it"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word>
ROUTE: <one of: requested-pull-request | pass-on-lookup | ask-name | ask-two-way | explain-and-ask-two-way | start-new | resume | final-message>
