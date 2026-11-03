---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, e2e]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not start a browser, Electron, CI, or external worker.

The target repo's pnpm test:lanes report selects web e2e and Desktop test:e2e. The local machine has no displayless Linux harness. The configured remote Mac is permitted to open Electron windows and has an E2E slot. A prior pre-pr-lanes receipt says Desktop not-run. A linux-walk control run passed. Postmerge desktop-e2e/validated exists but has not run on this PR. State the execution and evidence requirements, then explain the outcome when the remote runner is unreachable and no qualifying automatic premerge CI starts.

Answer exactly:
WEB: <execution mode>
DESKTOP: <execution mode and evidence record>
NOT-RUN: <whether prior receipt or control walk completes the lane>
UNREACHABLE: <status and PR record>
