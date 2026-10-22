---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, questions, precedent]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- App session `invoice-credit-line` (worktree recorded), live ticket ISS-5333. The person is a product manager.
- The writer's open question: "When a seat is removed mid-month, should the next invoice show the credit as its own line or fold it into the subscription line?"
- Graph research: `ticket_detail` ISS-5333, `fts_search` "seat credit invoice line", `search_memory_facts` "mid-month seat removal credit": no ruling anywhere.
- The code/data model, ticket/PRD/rulings, graph/live decisions, product-owner direction and prototype did not settle the question. `precedent-check.mjs run --code-evidence "packages/billing/invoice.ts:42"` then checked live Asana, which reported `undocumented` (it has no comparable credit line on the next invoice). Cleanup: nothing created.
- `session-questions.mjs ask --key seat-credit-line --question "<the question>" --worktree "<wt>"` returned `{"ask":true}`.

The person has not said anything new.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-question | send-back-to-writer | research-further | build-to-answer | wait-for-answer>
NEXT: <for research-further, the exact app, website or source you check next; for build-to-answer, the source you record with the answer; otherwise none>
