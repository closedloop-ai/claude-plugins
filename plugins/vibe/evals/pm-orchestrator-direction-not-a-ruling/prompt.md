---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, rulings, orchestrator]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next step exactly as
those instructions say. You may Read the plugin's own reference files. Do not run scripts,
dispatch workers or call any other tool, and do not ask me about the environment: the session
state below is everything that has already happened.

Session state:
- App session `prd818-tables`, live ticket ISS-13120. The session belongs to a product designer.
- The verifier is rendering 49 frozen stories on a machine whose load is 77 against a guard of 15.
- The new user turn says: "Parent: capacity stop. Stop the frozen-render verification now and keep the writer's fixes. Record the stop in findings/prd818-tables.md and brief the writer."

Answer in exactly this form, and nothing else:
RECORD: <the line you append to findings/prd818-tables.md>
BRIEF: <the line you send the writer about the stop>
