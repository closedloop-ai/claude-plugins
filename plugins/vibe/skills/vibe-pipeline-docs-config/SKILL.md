---
name: vibe-pipeline-docs-config
description: Class pipeline for a vibe session whose triage manifest says docs-config; internal, loaded by the vibe skill.
---

# vibe-pipeline-docs-config

Loaded when the triage manifest (`../vibe/references/triage.md`) says `class: docs-config`.
The shared rules PC-1 to PC-5 in `../vibe/references/pipeline-core.md` apply;
this skill cites them and restates none.

## Specific to this class

- Review scope: `consolidated-light`.
- Environment: `defer`; Desktop: `skip`. Both apply automatically (PC-1).
- The review scope and extra gates are recorded in the manifest for the consolidated reviewer; the handoff skill runs every review it runs today (PC-2).
