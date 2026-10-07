# Stubbing data and actions

This applies to **draft** scope sessions. In full scope, the backend is built
for real by `vibe-backend-worker` and nothing is stubbed.

Draft vibe sessions never write backend code. When the UI needs data the API does
not return, or an action the API cannot perform, build the UI against a stub
and record exactly what engineering must implement. Stubs are temporary by
design: engineering replaces each one when they build the real endpoint.

## First check whether a stub is needed

Search `packages/app/<feature>/hooks/` and `packages/app/shared/api/` for an
existing hook or query, and the matching route under `apps/api/app/`, before
stubbing. Reading `apps/api` is fine; editing it is not. If an existing
endpoint already returns the data, use it.

## The stub file

One stub file per feature need, named `<need>.vibe-stub.ts`, in the owning
feature slice: `packages/app/<feature>/vibe-stubs/<need>.vibe-stub.ts`. It
holds the response type, the requirement, and the fixture together, so the
handoff skill can inventory every stub mechanically.

```ts
export type ProjectHealthSummary = {
  projectId: string;
  score: number;
  signals: { label: string; value: number }[];
};

export const projectHealthStub = {
  requirement: {
    id: "project-health-summary",
    kind: "read",
    need: "Health score for one project and the three signals behind it",
    suggestedEndpoint: "GET /projects/:projectId/health",
    responseType: "ProjectHealthSummary",
    consumers: ["packages/app/projects/hooks/use-project-health.ts"],
    rules: [
      "score is 0 to 100",
      "signals are ordered by impact, highest first",
    ],
  },
  fixture(projectId: string): ProjectHealthSummary {
    return {
      projectId,
      score: 72,
      signals: [
        { label: "Open blockers", value: 3 },
        { label: "Overdue issues", value: 2 },
        { label: "Stale reviews", value: 1 },
      ],
    };
  },
} as const;
```

- `kind` is `read` or `write`.
- `rules` are the behaviors the person described (sorting, limits, who can
  see it, what happens on failure). Write their words; do not invent policy.
- Fixture values look real and use the seeded data where an id or name is
  involved, never placeholder text.
- No comments describing it as temporary; the `.vibe-stub.ts` name and the
  `requirement` object already say so.

## Wiring the stub

The hook keeps the shape a real hook would have, so engineering only swaps the
query function:

```ts
export function useProjectHealth(projectId: string) {
  return useQuery({
    queryKey: projectKeys.health(projectId),
    queryFn: () => projectHealthStub.fixture(projectId),
  });
}
```

For a `write` stub, the mutation function updates the TanStack Query cache so
the UI behaves as if the save worked, and the requirement lists the request
body and the expected response. Components never import a stub file
directly; only hooks do.

## Where requirements go

When the change worker makes a stub, it adds that stub's requirement to the
live ticket's API requirements section right away (`ticket-template.md`), so
engineering can see what is needed while the work is still going. At handoff
the inventory lists every `*.vibe-stub.ts` file in the diff and checks that
no stub is imported outside a hook, `vibe-api-requirements-writer` turns the
`requirement` objects into `api-requirements.md`, and the ticket worker
reconciles the ticket's section with it and attaches the file.
