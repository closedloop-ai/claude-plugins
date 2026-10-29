---
name: vibe-pipeline-trivial-ui
description: Class pipeline for a vibe session whose triage manifest says trivial-ui; internal, loaded by the vibe skill.
---

# vibe-pipeline-trivial-ui

Loaded when the triage manifest (`../vibe/references/triage.md`) says `class: trivial-ui`.
The shared rules PC-1 to PC-5 in `../vibe/references/pipeline-core.md` apply;
this skill cites them and restates none.

## Specific to this class

- Review scope: `consolidated-light`.
- Environment: `defer` (create it on first view); Desktop: `skip` only when the evidence names no Desktop-relevant surface. Both apply automatically (PC-1).
- The review scope and extra gates are recorded in the manifest for the consolidated reviewer; the handoff skill runs every review it runs today (PC-2).
