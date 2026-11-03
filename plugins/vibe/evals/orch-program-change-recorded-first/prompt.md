---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, state]
---

This is a rehearsal of one turn of a fleet-orchestrator session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:fleet-orchestrator`) and decide
your next step exactly as those instructions say. You may Read the plugin's own reference files.
Do not run scripts, dispatch workers or call any other tool, and do not ask me about the
environment: the session state below is everything that has already happened.

Session state:
- Fleet home with active program `prd-802` (PRD-802; one ticket, ISS-12712, blocked on an unmerged PR). No writers running.
- The newest `resume-log.md` entry: "Pending: operator ruling on how to proceed (wait for the blocker or stack on it)".
- `rulings.md` holds no ruling for this program yet.
- The operator just said: "I don't want to build anything yet. I want to come up with a design. We may end up taking it over."

Answer in exactly this form, and nothing else:
FIRST: <one of: record-ruling | reply-only | launch-writer | ask-question>
RECORD: <each line you append to orchestration state before replying, with the file it goes in, or NONE>
REPLY: <the message you would send the operator, word for word>
