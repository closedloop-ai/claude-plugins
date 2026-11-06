---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, reuse, iss-13532]
description: Two new files define the same helper body in one PR.
---

Load `vibe:handoff`, then read `agents/vibe-guardrails-reviewer.md`. The diff gate reports `duplicate-helper` on the PR 9366 addition below. The same function already exists in `packages/app/shared/components/generic-artifact-surface/preview/components/add-artifact-dialog.tsx:428`:

Name the shared helper owner and which duplicate function should be removed, rather than approving both copies.

`packages/app/shared/components/artifact-creation/artifact-creation-dialog.tsx:504`
```ts
function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
```

Report one finding in the form `blocking | file:line | problem | evidence | fix`, naming both sites. Do not edit code.
