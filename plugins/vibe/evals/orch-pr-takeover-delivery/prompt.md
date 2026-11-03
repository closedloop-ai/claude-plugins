---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, delivery]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not commit, push, merge, reply, or mutate anything.

The PR writer has fixed two verified bugs and left the worktree uncommitted. The root has reviewed the diff and the selected checks passed. One review thread asks for the fix; another is disproved by current file and line evidence. The PR's live head still matches the fetched head. Describe commit, push, thread handling, and the terminal PR state. A force push and auto-merge are unacceptable.

Answer exactly:
COMMIT: <owner and mechanism>
PUSH: <method and target>
THREADS: <answers>
PR: <terminal state>
