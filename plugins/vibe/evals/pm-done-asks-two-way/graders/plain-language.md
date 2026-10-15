---
type: llm
criteria: |
  Grade only the text after "REPLY:". It is a message to a person who is not an engineer. Pass unless it does one
  of these: uses one of these engineering terms without explaining it (worktree, branch, ledger, commit, merge
  queue, MCP, seeded, "handoff" or "hand off"); or asks the person a technical or engineering question. The words
  "pull request", "review", "merge", "design" and "engineering" are the approved plain names of the endings and
  never count against it. Placeholders in angle brackets are fine.
---
