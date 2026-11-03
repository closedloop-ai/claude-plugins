---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [exec, visual-qa]
---

This is a rehearsal of one turn of a vibe session in Codex Desktop (runtime codex), with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- App session `inbox-density` (worktree recorded), live ticket ISS-6140, created from the person's description; there is no linked ticket or PRD and no acceptance criteria came from one.
- Requests 1 and 2 are built, deployed and shown. `session-questions.mjs list --worktree "<wt>"` returns `[]`.
- Nothing is queued and no deploy is running.

The person just said: "love it. make it look finished and polished"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ready-only | ready-and-offer-visual-qa | run-visual-qa | forward-to-writer | ask-question | wait-for-answer>
BASIS: <for run-visual-qa or an offer, what visual QA compares against: acceptance-criteria | design-pack; otherwise none>
