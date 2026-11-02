---
name: vibe-pipeline-backend
description: Class pipeline for a vibe session whose triage manifest says backend; internal, loaded by the vibe skill.
---

# vibe-pipeline-backend

Loaded when the triage manifest (`../vibe/references/triage.md`) says `class: backend`.
The shared rules PC-1 to PC-5 in `../vibe/references/pipeline-core.md` apply;
this skill cites them and restates none.

## Specific to this class

- Review scope: `consolidated`.
- Extra gate recorded: `workflow-code-review` (the closedloop-core skill).
- Backend ownership, schema, migration and seed checks follow `../vibe/references/guardrails.md`; the API lane comes from `pnpm test:lanes` (PC-3).
- Environment: recommended `defer`; Desktop: recommended `skip`. Both take effect only while the triage switch is on (PC-1).
- The review scope and extra gates are recorded in the manifest for the consolidated reviewer; the handoff skill runs every review it runs today (PC-2).
