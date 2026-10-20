---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, review-gates]
description: "A new Desktop sync lane uses the shared give-up and backoff and gets a Susan pass."
---

This is a rehearsal of `vibe-backend-worker` guidance during a vibe session.
Load the instructions with the Skill tool (`vibe:vibe`) and read the backend
worker's guidance and the review gates it names. Do not run scripts or ask
questions.

The request needs Desktop edits to reach the cloud while offline. The writer
plans a new outbox lane file
`apps/desktop/src/main/agent-sync/placement-outbox.ts` and a new
`placement_sync_outbox` table, with its own 24 hour give-up and a
`1000 * 2 ** attempt` retry delay.

Return exactly three lines: `GIVE_UP:`, `BACKOFF:` and `REVIEW:`.
