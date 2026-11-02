---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, flag, iss-13532]
description: An unresolved feature flag may replace an open creation dialog and lose entered text.
---

Load `vibe:handoff`, then read `agents/vibe-adversarial-reviewer.md`. Review this source excerpt from PR 9366 as a read-only adversarial reviewer. The flag hook returns false while PostHog has not resolved. The create action keeps the dialog open while the hook updates:

The shared `useFeatureFlagGate` hook exposes `isReady` for this flag. Name the existing readiness mechanism in the fix.

`packages/app/documents/components/index/documents-create-action.tsx:77`
```tsx
const composer = useFeatureFlagEnabled(ARTIFACT_CREATION_COMPOSER_FEATURE_FLAG_KEY);
if (composer) return <DocumentCreationDialog open={open} />;
return <NewDocumentModalRecoverable open={open} />;
```

Report one finding in the form `blocking | file:line | problem | evidence | fix`. Do not edit code.
