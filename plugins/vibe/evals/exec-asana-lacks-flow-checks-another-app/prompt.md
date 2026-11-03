---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 8
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [exec, questions, precedent]
---

This is a rehearsal of one turn of a vibe session in Codex Desktop (runtime codex), with no real
environment. Load the instructions with the Skill tool (`vibe:vibe`) and decide
your next message to the person exactly as those instructions say. You may Read
the plugin's own reference files. Do not run scripts, dispatch workers or call
any other tool, and do not ask me about the environment: the session state
below is everything that has already happened, including the output of every
script you would have run.

Session state:
- App session `github-connect-settings` (worktree recorded), live ticket ISS-5201. The person is an executive.
- The writer's open question, already checked against the code and data model, ticket, PRD, rulings, graph/live decisions, product-owner direction and approved prototype with no answer: "If someone starts connecting GitHub and cancels on GitHub's authorization screen, what should the settings page show when they come back?"
- You ran `node scripts/precedent-check.mjs prompt --question "<that question>" --code-evidence "packages/integrations/state.ts:42"` and followed its brief through the browser-holder. Asana does not have this situation: its integrations do not connect a GitHub account through GitHub's authorization screen (observed 2026-10-16). Nothing was created.
- `session-questions.mjs list --worktree "<wt>"` returns `[]`.

The person has not said anything new.

Answer in exactly this form, and nothing else:
REPLY: <the message you would send the person now, word for word, or NONE if you would send nothing>
ROUTE: <one of: ask-question | send-back-to-writer | research-further | build-to-answer | wait-for-answer>
NEXT: <for research-further, the exact app, website or source you check next; for build-to-answer, the source you record with the answer; otherwise none>
