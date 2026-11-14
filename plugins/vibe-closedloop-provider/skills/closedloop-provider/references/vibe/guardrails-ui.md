# Provider text for skills/vibe/references/guardrails-ui.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: missing-primitive-steps -->
2. Run the repo agent `design-system-steward` (`.claude/agents/design-system-steward.md`)
   with the need. Follow its answer, which is one of three:
<!-- end: missing-primitive-steps -->

<!-- block: missing-primitive-steps-2 -->
   - Create: a new component, placed where the steward says. Generic and
     domain-free goes in `packages/design-system/components/ui/`; domain UI
     goes in its feature slice under `packages/app/<feature>/components/`.
<!-- end: missing-primitive-steps-2 -->

<!-- block: missing-primitive-steps-3 -->
   empty, error). Ask the steward for what its answer leaves out. State text
   follows the Copy rules below.
3. Build it to the repo's Storybook and design-system rules
   (`apps/storybook/AGENTS.md`, `packages/design-system/AGENTS.md`), using the
   repo skill `.claude/skills/storybook` (`workflows/author-stories.md`,
   `workflows/design-controls.md`):
   - Stories follow "Storybook taxonomy" below: a current root, the page
     tree and a lifecycle tag, never a v1.0 root.
   - Stories go where Storybook collects them. For `packages/design-system`
     that is `apps/storybook/stories/` (a story next to the component is
     never picked up); `packages/app/*/components/` stories may sit beside the
     component.
   - A new `packages/design-system/components/ui/*.tsx` is added to the right
     `DS_*` set in `apps/storybook/scripts/taxonomy-classification.mjs`. Its
     tests are not written in the session; handoff lists them for engineering
     (Tests, below).
   - Register it by running `pnpm --filter storybook catalog:sync` and
     `pnpm --filter storybook validate:catalog`. Never hand-edit
     `component-catalog.ts`.
4. Run the Storybook tests for the new or changed story files only
   (`pnpm --filter storybook exec vitest run <story files>`), never the whole
   `pnpm --filter storybook test` suite, and confirm the new stories pass.
<!-- end: missing-primitive-steps-3 -->

<!-- block: taxonomy-doc -->
Read the repo's `apps/storybook/TAXONOMY.md` and follow it for every story
<!-- end: taxonomy-doc -->

<!-- block: version-history -->
  after the `version` in `apps/storybook/package.json` on the main it last
<!-- end: version-history -->

<!-- block: precedent-stories -->
`apps/storybook/TAXONOMY.md`, never the neighbors in the same folder.
<!-- end: precedent-stories -->

<!-- block: bundled-tokens -->
  `packages/design-system/styles/globals.css`; for a static or generated page,
<!-- end: bundled-tokens -->
