---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, visual-qa]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- App session `bulk-labels` (worktree recorded), live ticket ISS-6120. The ticket has acceptance criteria, quoted in the session decision table.
- Requests 1 to 3 are built, deployed and shown. Request 1's ready message offered visual QA under key `visual-qa:req-1` and the person has not answered it; requests 2 and 3 were small edits.
- Nothing is queued and no deploy is running.

The person just said: "this looks good! now make it polished"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ready-only | ready-and-offer-visual-qa | run-visual-qa | forward-to-writer | ask-question | wait-for-answer>
BASIS: <for run-visual-qa or an offer, what visual QA compares against: acceptance-criteria | design-pack; otherwise none>
