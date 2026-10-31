---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, fleet-single-use]
description: "A design and analysis session with no writer is a no-writer program: rulings are recorded, nobody is launched to write."
---

This is a rehearsal of the first turn of a fleet-orchestrator chat in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:fleet-orchestrator`) and decide your
next step exactly as those instructions say. You may Read the plugin's own skill, reference and
script files. Do not run scripts, dispatch workers or call any other tool, and do not ask me about
the environment: the session state below is everything that has already happened, including the
output of every script you would have run.

Session state:
- The operator typed: "/vibe:fleet-orchestrator I don't want to build anything yet. Help me work out what PRD-800's design is missing; we may take it over later."
- `fleet-home.mjs resume` printed `NO-ACTIVE-PROGRAM: start one with fleet-home.mjs start <slug>; it reads no earlier program's state`.
- `config.env` exists and passed its checks last week.
- `node ../vibe/scripts/plugin-version.mjs check` returned `{"status":"current","outdated":[],"versions":""}`.

Answer in exactly this form, and nothing else:
COMMANDS: <every command you run next, in order, separated by " ; ", or NONE>
RECORD: <what you write to the program's state files now, or NONE>
REPLY: <your message to the operator, word for word>
ROUTE: <one of: ask-update-or-proceed | start-program | launch-writers | ask-question>
