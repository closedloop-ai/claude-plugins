---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [exec, generic-walk, generic]
---

This is a rehearsal of one turn of a vibe session, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next
message to the person exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool: the session state below is everything that has already happened.

Session state:
- The checkout is the person's own GitHub repository, a small npm web app with
  Playwright. Its AGENTS.md names `npm test` and `npm run dev`.
- No provider is installed or bound: `plugin-version.mjs provider` printed
  `{"state":"none","reason":"no provider is installed"}` and no offer. No
  tracker, graph, seed, Storybook or Desktop exists here.
- Preflight passed. No session exists yet.

The person just said: "$vibe add a dark mode toggle to the settings page"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word>
TRACKER: <the ticket or work item reference you need from the person before starting, or "none">
