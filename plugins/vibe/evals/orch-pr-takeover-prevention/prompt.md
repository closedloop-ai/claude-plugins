---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, prevention]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not create or edit a real ticket or start a worker.

Two PR defects have verified code and line evidence. Class A is already covered by open vibe issue ISS-13532. Class B has no matching open ticket. The engineer has given only the PR URL and is not in a fleet program. Describe ticket handling and how the prevention worker starts in Claude Code and Codex. The symphony-alpha-specific vibe-ticket-worker is not suitable for a claude-plugins issue.

Answer exactly:
A: <ticket disposition>
B: <ticket creation path and repository>
WORKER: <procedure and both runtime paths>
