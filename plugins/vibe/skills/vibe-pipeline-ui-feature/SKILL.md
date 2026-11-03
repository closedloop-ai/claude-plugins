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
- Environment: recommended `run`, so the triage switch never defers it for this class. Desktop: recommended `run` when a Desktop-relevant surface is in the evidence, `skip` when touched paths are known and name none (a web-only change), `unknown` when the class rests on request text alone. With the switch on, a web-only multi-file UI change leaves Desktop out (PC-1).
- Class `data-metric` also loads this skill and records the extra gate `logical-qa`, with Desktop recommended `run`.
- The review scope and extra gates are read by the handoff's `review-scope.mjs --manifest`, which applies them only while the triage switch is on and only adds review work (`../vibe/references/triage.md`, "What the handoff does with the review steps"); the handoff skill runs every review it runs today (PC-2).
