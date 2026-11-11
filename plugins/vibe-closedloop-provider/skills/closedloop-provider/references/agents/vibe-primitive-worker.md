# Provider text for agents/vibe-primitive-worker.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-list -->
`provider:closedloop-graph.md`,
`../skills/vibe/references/quality-loop.md` (internal quality and graph-first product questions),
`provider:ticket-template.md`, and
`../skills/vibe/references/guardrails-ui.md` ("Missing primitives" steps 2 to 4
are yours; the orchestrator sends the step 5 notice and does not wait). The repo's
`apps/storybook/AGENTS.md`, `packages/design-system/AGENTS.md`, the storybook
skill (`.claude/skills/storybook/SKILL.md`, `references/gotchas.md`,
`workflows/author-stories.md`, `workflows/design-controls.md`), and
`.claude/design/discipline-core.md`.
<!-- end: read-list -->

<!-- block: no-duplicate -->
1. Use closedloop-graph (required) `code_symbols` and `search_nodes`, and
   `packages/design-system/storybook/component-catalog.ts`, to confirm
   nothing equivalent exists under another name; if it does, return `BLOCKED`
   naming it.
<!-- end: no-duplicate -->

<!-- block: stories -->
3. Stories in a collected location with controls, and a `DS_*` taxonomy
   entry for a new `packages/design-system/components/ui/*.tsx`. No tests.
   Place them per the repo's `apps/storybook/TAXONOMY.md`: a current root,
   one lifecycle tag and the release bump, never a frozen v1.0 root
   (`guardrails-ui.md`, "Storybook taxonomy").
<!-- end: stories -->

<!-- block: graph-block -->
End with the Graph block (`closedloop-graph.md`).
<!-- end: graph-block -->
