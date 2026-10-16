---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, version-check]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- The person just typed: "/vibe:vibe pick up where I left off". This is a new conversation.
- `node scripts/plugin-version.mjs --runtime claude` returned `{"status":"current","installed":"1.0.53","latest":"1.0.53"}`.
- The preflight passed and both connections answer. `node scripts/vibe-sessions.mjs list` returned one active session: `{"slug":"bulk-labels","summary":"Bulk labels on the task list","lastActiveAt":"<yesterday>","changedFiles":4,"status":"active"}`.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-keep-going-or-update | continue-session | offer-sessions-to-resume | run-update | ask-reopen | ask-question>
