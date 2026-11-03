---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, questions]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next step exactly as
those instructions say. You may Read the plugin's own reference files. Do not run scripts,
dispatch workers or call any other tool, and do not ask me about the environment: the session
state below is everything that has already happened, including the output of every script you
ran.

Session state:
- App session `seat-credit-line` (worktree recorded), live ticket ISS-5333. The person is a product manager.
- The writer returned `NEEDS_PERSON`: "When a seat is removed mid-month, should the next invoice show the credit as its own line or fold it into the subscription line?"
- Research is done: the code and data model (`packages/billing/invoice.ts:42`), the ticket and PRD, the graph, the product owner's direction, the prototype and live Asana all left it open.

Answer in exactly this form, and nothing else:
NEXT_COMMAND: <the exact command you run before messaging the person, or NONE>
REPLY: <the message you would send the person now, word for word, or NONE if you must run a command first>
