---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, state, compaction]
---

This is a rehearsal of one turn of a fleet-orchestrator session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:fleet-orchestrator`) and decide
your next step exactly as those instructions say. You may Read the plugin's own reference files.
Do not run scripts, dispatch workers or call any other tool, and do not ask me about the
environment: the session state below is everything that has already happened.

Session state:
- Your context was just compacted. All you have is the harness summary: "Program prd-800, design from scratch. Published the Session Cost Model page twice. apps/desktop has 172 changed files (about 120 are golden snapshots)."
- The fleet home has an active program.
- The operator's next message: "Publish the updated design page with the cost section."

Answer in exactly this form, and nothing else:
FIRST: <one of: run-fleet-home-resume | publish-page | reply | ask-question>
WHY: <one sentence>
