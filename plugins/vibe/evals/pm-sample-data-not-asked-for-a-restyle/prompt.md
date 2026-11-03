---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, sample-data]
---

This is a rehearsal of one turn of a vibe session in Claude Code, with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- Preflight passed and both connections answered. No session exists yet. `get-me` says the person is pat.lee@example.com.
- The person, a product manager, sent: "make the settings page's save button match the one on the profile page (screenshot attached)"
- The requirements worker found the settings page and no existing ticket. The person said nothing about data. Nothing has been asked yet.

Decide your next message to the person.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: relay-sign-in | ask-question | use-recorded-answer | keep-building | wait-for-answer>
