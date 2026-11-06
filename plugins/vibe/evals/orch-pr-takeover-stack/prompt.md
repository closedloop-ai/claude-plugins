---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 240
allowed_tools: [Skill, Read, Grep, Glob]
tags: [orchestrator, pr-takeover, stack]
---

This is a read-only rehearsal. Load (`vibe:pr-takeover`). Do not fetch, merge, push, or edit anything.

PR #9448 is stacked on open PR #9366. Its live base is the parent branch, not main. The child merges cleanly against that parent but has five conflicts against current main, including a toolbar behavior conflict and Storybook version history. An adversarial reviewer normally diffs from origin/main. Describe the correct review and repair sequence without reviewing the parent diff as part of the child.

Answer exactly:
REVIEW: <diff base>
CONFLICTS: <checks against both refs>
ORDER: <repair and Storybook order>
