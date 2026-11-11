---
name: vibe-pipeline-backend
description: Class pipeline for a vibe session whose triage manifest says backend; internal, loaded by the vibe skill.
---

Lines that start `> Provider` follow `../vibe/references/provider-text.md`.

# vibe-pipeline-backend

Loaded when the triage manifest (`../vibe/references/triage.md`) says `class: backend`.
The shared rules PC-1 to PC-5 in `../vibe/references/pipeline-core.md` apply;
this skill cites them and restates none.

## Specific to this class

- Review scope: `consolidated`.
- Extra gate recorded: `workflow-code-review` (the closedloop-core skill).
<!-- generic: api-lane -->
- Backend ownership, schema, migration and seed checks follow `../vibe/references/guardrails.md`; the API lane comes from the repository's lane source (PC-3).
<!-- end generic: api-lane -->
> Provider `recipes` (block `api-lane` of `pipelines/backend.md`)
- Environment: recommended `defer`; Desktop: recommended `skip`. Both take effect only while the triage switch is on (PC-1).
- The review scope and extra gates are read by the handoff's `review-scope.mjs --manifest`, which applies them only while the triage switch is on and only adds review work (`../vibe/references/triage.md`, "What the handoff does with the review steps"); the handoff skill runs every review it runs today (PC-2).
