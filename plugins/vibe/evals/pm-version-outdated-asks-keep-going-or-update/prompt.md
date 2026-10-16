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
- The person just typed: "/vibe:vibe I want to add bulk labels to the task list". This is a new conversation; no session exists yet.
- `node scripts/plugin-version.mjs --runtime claude` returned `{"status":"outdated","installed":"1.0.52","latest":"1.0.53","update":["claude plugin marketplace update closedloop-ai","claude plugin update vibe@closedloop-ai"]}`.
- Nothing else has run yet.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-keep-going-or-update | continue-session | offer-sessions-to-resume | run-update | ask-reopen | ask-question>
