---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, review]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not fetch the PR, edit files, create tickets, or start workers.

The independent reviewer reports F1 at a PR file and line. Its code premise is verified, but its platform capability premise is marked UNVERIFIED. A human review thread already fixed a separate verified defect. Tell the engineer how the takeover root handles F1 and the verified review thread. No automatic PR review is requested.

Answer exactly:
F1: <status and allowed side effects>
ROOT: <premise recheck>
THREAD: <disposition>
