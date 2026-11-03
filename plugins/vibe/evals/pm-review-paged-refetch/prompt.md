---
max_turns: 8
timeout_seconds: 120
runs: 1
plugins: ["../..", "../../../closedloop-core"]
allowed_tools: [Skill, Read, Grep, Glob]
tags: [review, cache, iss-13532]
description: A small edit invalidates every cached page of an infinite activity query.
---

Load `vibe:handoff`, then read `agents/vibe-adversarial-reviewer.md`. Review this PR 9448 source pair. The Activity summary can cache 20 pages, while a status toolbar edit runs the mutation:

The query library offers `maxPages`, and mutation invalidation supports `refetchType`. Name the concrete bound in the fix.

`packages/app/documents/hooks/use-documents.ts:202`
```ts
queryClient.invalidateQueries({ queryKey: artifactActivityFeedKeys.detail(input.id) });
```

`packages/app/documents/hooks/use-artifact-activity-feed.ts:39`
```ts
return useInfiniteQuery({ queryKey: artifactActivityFeedKeys.detail(documentId), getNextPageParam, staleTime: 30000 });
```

The query has no `maxPages` and no selective refetch. Report one finding in the form `blocking | file:line | problem | evidence | fix`. Do not edit code.
