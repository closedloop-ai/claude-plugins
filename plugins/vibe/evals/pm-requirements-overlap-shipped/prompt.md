---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 16
timeout_seconds: 180
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, qa-lessons]
description: "Requirements overlap includes graph collisions, file blast radius, open pull requests, and shipped rules."
---

This is a rehearsal of requirements research for a vibe session. Load the
instructions with the Skill tool (`vibe:vibe`), then do the
`vibe-requirements-worker` work yourself. Do not run scripts or ask questions.

The request changes a list selection component. A preliminary note includes
only a keyword search and says there is no overlap. No collision query or file
blast-radius query is recorded. An executed PRD has done child tickets that
shipped selection rules, and an open pull request changes the same component
file.

Return a concise overlap checklist naming every required lookup and every
result that must be reported before implementation starts.
