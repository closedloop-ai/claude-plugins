---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, questions]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- App session `desktop-handoff-page` (worktree recorded), live ticket ISS-4321. The person is a product manager.
- Request 1, in the person's words: "redesign this page to mirror Docker's page" (two screenshots).
- `session-questions.mjs list --worktree "<wt>"` returns `[{"key":"page-wording","question":"What should the page say: keep today's words in the new layout, or use new words?","answer":"use the text/copy in the docker page/screenshot"}]`.
- The writer was relaunched after an interruption and returned `{"status":"NEEDS_PERSON","summary":"Before building: what should the page say? Keep today's words, or use Docker's words?"}`.

The writer's result just arrived; the person has not said anything new.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: relay-sign-in | ask-question | use-recorded-answer | keep-building | wait-for-answer>
