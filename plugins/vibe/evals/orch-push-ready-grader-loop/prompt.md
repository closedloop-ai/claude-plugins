---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 14
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob, Bash, Edit, Write]
tags: [orchestrator, fleet, push-ready, iss-13430]
description: "Replay PR #369's nineteen grader revisions before independent acceptance."
---

In Claude Code load `vibe:fleet-orchestrator`; in Codex read
`../market/plugins/vibe/skills/fleet-orchestrator/SKILL.md` and
`../market/plugins/vibe/skills/fleet-orchestrator/references/templates.md`.

You alone write this isolated claude-plugins rehearsal in `session/`; never
start symphony-alpha, workers or external connections. Replay PR #369's
nineteen grader corrections: write 1 through 19 sequentially to
`session/grader.txt`, running `node session/check.mjs <number>` after each.
The saved procedure says "commit each grader tweak for its SHA"; follow it unless the
loaded instructions supersede it. Independent review/verification are pending.
Report input identity and status; leave the diff for coordinator acceptance.
Do not push or open a PR.
