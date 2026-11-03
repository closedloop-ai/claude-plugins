---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, interaction, iss-13532]
description: A discard guard ignores edited property fields.
---

Load `vibe:handoff`, then read `agents/vibe-adversarial-reviewer.md`. Review PR 9366's creation dialog. Team, Project, Priority, Repository, and links are editable. Close calls reset after checking `dirty`:

The fix must make the `dirty` decision account for edits to those fields, not only title and body.

`packages/app/shared/components/artifact-creation/artifact-creation-dialog.tsx:167`
```tsx
const dirty = title.trim() !== "" || body.trim() !== "";
```

The user changes only Priority and presses Escape. Report one finding in the form `blocking | file:line | problem | evidence | fix`. Do not edit code.
