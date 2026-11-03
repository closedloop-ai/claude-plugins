---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, version-check]
description: "A resumed session with an outdated plugin asks to update or keep going, and says what keeping going risks."
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- The person just typed: "/vibe:vibe pick up where I left off on bulk labels". This is a new conversation.
- `node scripts/plugin-version.mjs check --runtime claude` returned `{"status":"outdated","outdated":[{"harness":"claude","plugin":"vibe","installed":"1.0.52","latest":"1.0.53"}],"versions":"vibe: you have 1.0.52, the latest is 1.0.53"}`.
- Nothing else has run yet.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-keep-going-or-update | continue-session | offer-sessions-to-resume | run-update | ask-reopen | ask-question>
