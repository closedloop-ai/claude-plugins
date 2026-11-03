---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, pr-path]
---

This is a rehearsal of one turn of a vibe session, with no real environment.
Load the instructions with the Skill tool (`vibe:handoff`) and decide your next
message to the person exactly as those instructions say. You may Read the
plugin's own reference files. Do not run scripts, dispatch workers or call any
other tool, and do not ask me about the environment: the session state below
is everything that has already happened.

Session state:
- App session `projects-board-chips`, live ticket ISS-4321 (https://app.closedloop.ai/acme/issues/ISS-4321), branch `vibe/projects-board-chips`.
- The person asked for a pull request. The finishing skill (`vibe:handoff`) ran every step: the tests were written, every check and review passed, the final commit was published (app https://vibe-projects-board-chips.example.vercel.app, Storybook https://vibe-projects-board-chips-storybook.example.vercel.app), and the ticket is complete.
- Its last step just returned: DONE, pull request https://github.com/closedloop-ai/symphony-alpha/pull/9999 opened on that branch.
- Earlier requests, in the person's words: "make the filter chips look like this Linear screenshot" (screenshot attached), "tighten the chip spacing to match it", "the selected chip needs the darker fill".
- This turn is the message to the person that ends the session.

The person just said: "(nothing new; write the closing message)"

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word>
ROUTE: <one of: requested-pull-request | pass-on-lookup | ask-name | ask-two-way | explain-and-ask-two-way | start-new | resume | final-message>
