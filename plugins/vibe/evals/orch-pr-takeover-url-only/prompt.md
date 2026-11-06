---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, url-only]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not call GitHub, create a worktree, start a worker, edit a file, or mutate a ticket. State the next actions from the skill.

An engineer opens a new Claude Code chat and gives only this URL: https://github.com/closedloop-ai/symphony-alpha/pull/9999. There is no local vibe session record, decision table, fleet board, worktree, or ticket in this chat. The PR is open. The engineer wants the full takeover.

Answer exactly:
ROUTE: <skill and input>
STEPS: <numbered actions in order>
BLOCK: <whether the absent session record blocks entry>
