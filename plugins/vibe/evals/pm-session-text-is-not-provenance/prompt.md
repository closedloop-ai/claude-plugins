---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, ledger-lessons]
description: "Rules sourced only from the session's own ticket or plan are blocking."
---

This is a rehearsal of `vibe-guardrails-reviewer` check 15, rule provenance.
Load the instructions with the Skill tool (`vibe:handoff`), then judge the
rules below. Do not run scripts or ask questions.

The session's live ticket is ISS-9000 and its PLN is PLN-900. The diff adds:

1. An analytics rate limit of 100 events per minute per organization. Its
   only source is PLN-900's acceptance criteria, which the session wrote.
2. A server refusal "nesting is limited to four levels". PRD-726 says the
   tree view shows four levels; it says nothing about refusing deeper writes.
3. Sort by updated date, quoting the person's own request in the session.

Return exactly three lines, `RULE1:`, `RULE2:` and `RULE3:`, each saying
`blocking` or `ok` and why.
