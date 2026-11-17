# Provider text for skills/vibe/references/design-pass.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: owner-slot -->
   is in `packages/design-system`, the slot is typed without domain nouns,
   because design-system code cannot import `packages/app`, `@repo/api`, or
   `@repo/database`. The domain wiring (data hooks, API calls, nouns, labels)
   stays in the owning feature package in `packages/app`, or
   `packages/app/shared` when more than one feature uses it, and is passed
<!-- end: owner-slot -->

<!-- block: owner-surface -->
   in `packages/app` (route shells stay thin), on the surface that already
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
   (`code_symbols` on the capability's names, `code_importers` on that
<!-- end: prep-precedent -->

<!-- block: plan-screens -->
- Screens: <each screen and host, with its FEATURE_MAP id>
- Gates: <flag gates the FEATURE_MAP lists for those screens, or none>
<!-- end: plan-screens -->

<!-- block: plan-components -->
- Existing components: <catalog or packages/app components and helpers to reuse, or none>
<!-- end: plan-components -->

<!-- block: sibling-sweep -->
  sites (the other children of the owner through `code_importers` and
  `code_callers`, repeated strings or calls through `code_grep`, then `rg` in
  the worktree for the session's own code) and consolidate repeats in the
<!-- end: sibling-sweep -->
