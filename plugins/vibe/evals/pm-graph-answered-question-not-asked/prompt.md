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
- App session `project-picker-archived` (worktree recorded), live ticket ISS-4410. The person is a product manager.
- Request 1, in the person's words: "add the new project picker to the task drawer".
- The requirements worker's brief, kept from the session start, quotes this acceptance criterion of the ticket's PRD: "Archived projects are hidden from every project picker" (PRD-812, approved by the product owner).
- `session-questions.mjs list --worktree "<wt>"` returns `[]`.
- The writer just returned `{"status":"NEEDS_PERSON","summary":"Should archived projects appear in the new picker?","sourcesChecked":[]}`.

The person has not said anything new.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-question | send-back-to-writer | research-further | build-to-answer | wait-for-answer>
NEXT: <for research-further, the exact app, website or source you check next; for build-to-answer, the source you record with the answer; otherwise none>
