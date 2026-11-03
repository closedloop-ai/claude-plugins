---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, pr-facts]
description: "A drafted pull request body that misses computed facts is not created."
---

This is a rehearsal of `vibe-environment-worker` pull-request mode. Load the
handoff instructions with the Skill tool (`vibe:handoff`), then decide what
this mode does next. Do not run scripts or ask questions.

The pull-request phase inventory reported one open pull request, #8960, sharing
`apps/api/app/artifact-links/service.ts`, and one flipped assertion at
`apps/api/__tests__/links.test.ts:41`. The drafted body says the change is
additive, lists no overlap, and does not mention the flipped assertion.
The inventory rerun with `--body` reported `blocking.prBody: false` with both
problems. The person is waiting for the link.

Return exactly three lines: `CREATE:` (whether `gh pr create` runs now),
`RETURN:` (the status this mode returns) and `FIX:` (what the body needs).
