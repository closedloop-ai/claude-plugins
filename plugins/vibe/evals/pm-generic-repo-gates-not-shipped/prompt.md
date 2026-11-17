---
runs: 1
plugins: ["../..", "../../../closedloop-core"]
max_turns: 10
timeout_seconds: 300
allowed_tools: [Skill, Read, Grep, Glob]
tags: [pm, generic-walk, generic]
---

This is a read-only rehearsal of a vibe handoff. Load (`vibe:handoff`) and read
what you need from the plugin's references. Do not run scripts or call any
other tool.

Session state:
- The session runs in the person's own GitHub repository. It ships no
  `/visual-qa`, `/logical-qa` or `/metal-andrew` skill, no design-system
  steward agent and no control skill.
- No provider is bound. The change touched one React settings page.
- The person said: "I'll get the PR merged myself."

Answer exactly:
GATES: <for each repository-owned review gate the handoff would run, what happens here>
ENDING: <how the session ends>
