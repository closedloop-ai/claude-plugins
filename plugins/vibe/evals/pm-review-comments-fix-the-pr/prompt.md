---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 12
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, pr-path, post-pr]
---

This is a rehearsal of one turn of a vibe session, with no real environment.
Load the instructions with the Skill tool (`vibe:vibe`) and decide your next
message to the person and what happens next, exactly as those instructions
say. You may Read the plugin's own reference files. Do not run scripts,
dispatch workers or call any other tool, and do not ask me about the
environment: the session state below is everything that has already happened.

Session state:
- App session `desktop-return-page`, status `handed-off`, live ticket ISS-4321, branch `vibe/desktop-return-page`.
- It ended the way the person asked: handoff opened pull request https://github.com/closedloop-ai/symphony-alpha/pull/9999 on that branch for her to take through review and merge, and it is still open.
- Earlier requests, in the person's words: "make the sign-in return page look like this screenshot" (screenshot attached), "give the Return to Desktop button a subtle pressed-in shadow".
- Engineering has since left review comments on that pull request asking for changes.

The person just said: "Engineering left review comments on my PR (https://github.com/closedloop-ai/symphony-alpha/pull/9999). Please fix the review comments."

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word>
ROUTE: <one of: fix-pull-request | requested-pull-request | pass-on-lookup | ask-name | ask-two-way | explain-and-ask-two-way | start-new | resume | final-message | already-finished>
STEPS: <what happens next, in order, one numbered line per step, naming the worker or script and its mode for each>
