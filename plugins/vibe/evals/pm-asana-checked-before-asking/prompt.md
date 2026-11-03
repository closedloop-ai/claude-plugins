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
- App session `github-connect-settings` (worktree recorded), live ticket ISS-5201. The person is a product manager.
- Request 1, in the person's words: "let people connect GitHub from the settings page".
- `session-questions.mjs list --worktree "<wt>"` returns `[]`.
- The writer just returned `{"status":"NEEDS_PERSON","summary":"If someone starts connecting GitHub and cancels on GitHub's authorization screen, what should the settings page show when they come back?","sourcesChecked":["ticket_detail ISS-5201: no criterion covers a canceled authorization","fts_search \"github authorization cancel\": no ticket or PRD","search_memory_facts \"cancel GitHub authorization\": no ruling"]}`.

The person has not said anything new.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-question | send-back-to-writer | research-further | build-to-answer | wait-for-answer>
NEXT: <for research-further, the exact app, website or source you check next; for build-to-answer, the source you record with the answer; otherwise none>
