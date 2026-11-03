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
- App session `bulk-labels` (worktree recorded), live ticket ISS-6120 with acceptance criteria. The person is an executive.
- Request 2, "add a label bar above the list", was the latest visible milestone. Its ready message offered visual QA: `session-questions.mjs list --worktree "<wt>"` returns `[{"key":"visual-qa:req-2","question":"Want me to check how it looks against the ticket's requirements and fix anything that's off?","answer":"no thanks, I don't need that"}]`.
- Request 3 was a small spacing edit. Everything is built, deployed and shown; nothing is queued.

The person just said: "looks good, just make it a bit more polished"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ready-only | ready-and-offer-visual-qa | run-visual-qa | forward-to-writer | ask-question | wait-for-answer>
BASIS: <for run-visual-qa or an offer, what visual QA compares against: acceptance-criteria | design-pack; otherwise none>
