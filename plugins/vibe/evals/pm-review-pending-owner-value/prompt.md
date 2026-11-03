---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, loading, iss-13532]
description: A pending current-user read appears to be a loaded Unassigned Owner.
---

Load `vibe:handoff`, then read `agents/vibe-adversarial-reviewer.md`. Apply its existing loading versus value rule to this PR 9366 excerpt. `useCurrentUser` is still pending and its data is undefined. The editor renders a null Owner as `Owner: Unassigned`:

The query result exposes `isPending`. Name how the fix uses that state rather than presenting pending data as an assignment value.

`packages/app/artifacts/components/creation-owner-field.tsx:44`
```tsx
const currentUser = useCurrentUser({ enabled: open });
const ownerId = pickedOwnerId ?? currentUser.data?.id ?? null;
return <ArtifactOwnerEditor owner={owner} />;
```

Report one finding in the form `blocking | file:line | problem | evidence | fix`. Do not edit code.
