# Provider text for agents/vibe-guardrails-reviewer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: plan-exclude -->
  Exclude only `.closedloop-ai/vibe-plans/` from deliverable files, not other
  ClosedLoop artifacts.
<!-- end: plan-exclude -->

<!-- block: design-discipline -->
- Repo rules: the root `AGENTS.md`, the nearest `AGENTS.md` for each changed
  directory, and `.claude/design/discipline-core.md`.
<!-- end: design-discipline -->

<!-- block: graph-required -->
closedloop-graph is required, per `../skills/vibe/references/closedloop-graph.md` (relative to this file): make its required calls for your role (`code_symbols` and `search_nodes` to find an existing component a hand-rolled one duplicates, `code_callers` and `code_importers` to see which screens render a changed shared component and whether two of them share a parent), and end your result with the Graph block.
<!-- end: graph-required -->

<!-- block: gate-script -->
holds the shape). It wraps the repository's Biome and `pnpm check:source-gates`
<!-- end: gate-script -->

<!-- block: constant-branch -->
     `editMode.isEditing` (PR #9732, ISS-13947). Then run
<!-- end: constant-branch -->

<!-- block: taxonomy -->
10. Storybook taxonomy (`guardrails-ui.md`, "Storybook taxonomy"): read the
    repo's `apps/storybook/TAXONOMY.md` as the session's base has it; the
    inventory's `storybookScheme` names that base's scheme. A new story file
<!-- end: taxonomy -->

<!-- block: version-history -->
    `apps/storybook/stories/start-here-version-history.stories.tsx` and
    `apps/storybook/package.json` against the base. More than one new entry,
<!-- end: version-history -->

<!-- block: channel-row -->
    does or could do the job (`closedloop-graph.md`, the row for channels that
<!-- end: channel-row -->

<!-- block: flag-retirement -->
14. Flag retirement: for each feature flag read, key constant or gate the
    diff deletes, read the comments on every ticket linked to the flag (the
    live ticket, its PRD, and the tickets `fts_search` finds for the key) with
    the ClosedLoop MCP `get-document-comments`. A recorded hold, rollout
    pause or parity list on the flag with no later human answer allowing the
    retirement is a blocking `engineering decision` finding, quoting the
<!-- end: flag-retirement -->
