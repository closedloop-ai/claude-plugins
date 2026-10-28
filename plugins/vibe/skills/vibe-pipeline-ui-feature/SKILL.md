---
name: vibe-pipeline-ui-feature
description: Class pipeline for a vibe session whose triage manifest says ui-feature; internal, loaded by the vibe skill.
---

# vibe-pipeline-ui-feature

Loaded when the triage manifest (`../vibe/references/triage.md`) says `class: ui-feature`.
The shared rules PC-1 to PC-5 in `../vibe/references/pipeline-core.md` apply;
this skill cites them and restates none.

## Specific to this class

- Review scope: `consolidated-adversarial`.
- Environment: recommended `run`; Desktop: recommended `run` when a Desktop-relevant surface is in the evidence, otherwise recorded `unknown` and run. Neither is ever left out, so the triage switch changes nothing for this class (PC-1).
- Class `data-metric` also loads this skill and records the extra gate `logical-qa`, with Desktop recommended `run`.
- The review scope and extra gates are recorded in the manifest for the consolidated reviewer; the handoff skill runs every review it runs today (PC-2).
