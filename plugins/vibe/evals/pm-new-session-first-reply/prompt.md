---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, notice]
---

This is a rehearsal of one turn of a vibe session, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next
message to the person exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened.

Session state:
- No session exists yet. Preflight passed, and both connectors answer.
- The person typed the request below with `$vibe`.

The person just said: "$vibe make the projects board filter chips look like this Linear screenshot (screenshot attached)"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word>
ROUTE: <one of: requested-pull-request | pass-on-lookup | ask-name | ask-two-way | explain-and-ask-two-way | start-new | resume | final-message>
