# Provider text for skills/vibe/references/design-pass.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: owner-slot -->
1. Behavior that the children of a shared parent share goes into that parent
   as a generic, domain-free slot or extension point, and each child opts in
   (one prop or one hook call) instead of reimplementing it. When the parent
   is in `packages/design-system`, the slot is typed without domain nouns,
   because design-system code cannot import `packages/app`, `@repo/api`, or
   `@repo/database`. The domain wiring (data hooks, API calls, nouns, labels)
   stays in the owning feature package in `packages/app`, or
   `packages/app/shared` when more than one feature uses it, and is passed
   in. A slot alone is not an owner: the shared state and its handlers
   (selection, grouping, collapse, paging) live in the parent or in one
   shared hook the parent calls, and a child passes only its domain wiring.
   Two children that each keep their own copy of that state behind the
   parent's slot is the red flag the root `AGENTS.md` names under shared
   behavior in the shared parent, even when the slot exists.
<!-- end: owner-slot -->

<!-- block: owner-surface -->
4. Behavior specific to one child stays in that child, in its feature package
   in `packages/app` (route shells stay thin), on the surface that already
   owns the entity (`guardrails.md`, "Where code goes").
<!-- end: owner-surface -->

<!-- block: prep-screens -->
1. Screens and gates: the FEATURE_MAP entry for each screen the request
   touches (`pnpm control feature show <id>`, or the entry in
   `.claude/skills/control/feature-map.json`) gives its web route, Desktop
   hash, flag gates, and code paths. A screen in `packages/app` has a web
   host (`apps/app`) and a Desktop host (`apps/desktop/src/renderer`).
<!-- end: prep-screens -->

<!-- block: prep-parent -->
2. The shared parent and its other children: the required closedloop-graph
   calls (`closedloop-graph.md`, Required calls) on each component you will
   touch, what it composes or inherits from, and what else builds on that
   parent.
   This session's earlier work is not in the graph, so read the change log
   and `rg` the worktree for it too.
<!-- end: prep-parent -->

<!-- block: prep-components -->
3. Existing components: `packages/design-system/storybook/component-catalog.ts`,
   the `packages/app` feature packages, and `packages/app/shared` for
   anything that already renders the concept, plus the paved paths and
   shared-surface rules in `packages/app/AGENTS.md` and the nearest
   `AGENTS.md` of each directory involved.
<!-- end: prep-components -->

<!-- block: prep-memory -->
4. Known pitfalls, when the `workflow-memory` command exists on this Mac.
   Run one query, where `<repo>` is the repository's name, adding
   `--env-file ~/.workflow/.env` when that file exists:
   `workflow-memory query --summary-only --repo <repo> --query "<screen and behavior keywords>"`
   Treat what it returns as hints to verify. Skip it when the command is not
   installed.
<!-- end: prep-memory -->

<!-- block: prep-precedent -->
5. Precedent: where the same capability already exists for a sibling
   entity (another entity's list or detail surface): the component that
   provides it, how its hosts consume it, and where its stories live
   (`code_symbols` on the capability's names, `code_importers` on that
   component). Where the owner rules, the repo's `AGENTS.md` ("Shared behavior
   belongs in the shared parent") and its docs already say how, follow them;
   where they do not, mirror the precedent's ownership, component and
   Storybook structure, never its root or version.
<!-- end: prep-precedent -->

<!-- block: plan-screens -->
- Screens: <each screen and host, with its FEATURE_MAP id>
- Gates: <flag gates the FEATURE_MAP lists for those screens, or none>
<!-- end: plan-screens -->

<!-- block: plan-components -->
- Existing components: <catalog or packages/app components and helpers to reuse, or none>
<!-- end: plan-components -->

<!-- block: sibling-sweep -->
- Sibling sweep: after the fix, look for the same shape or defect at sibling
  sites (the other children of the owner through `code_importers` and
  `code_callers`, repeated strings or calls through `code_grep`, then `rg` in
  the worktree for the session's own code) and consolidate repeats in the
  session's own code. Do not opt in children the person did not name; list
  them.
<!-- end: sibling-sweep -->
