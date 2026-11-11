# Provider text for skills/vibe/references/guardrails-ui.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: missing-primitive-steps -->
2. Run the repo agent `design-system-steward` (`.claude/agents/design-system-steward.md`)
   with the need. Follow its answer, which is one of three:
   - Reuse: an existing component covers it. Use it and continue.
   - Extend: add a variant or prop to an existing component. Never change an
     existing default; add the new behavior beside it.
   - Create: a new component, placed where the steward says. Generic and
     domain-free goes in `packages/design-system/components/ui/`; domain UI
     goes in its feature slice under `packages/app/<feature>/components/`.

   For Extend and Create, the spec covers the whole component: every variant
   and size, phone and desktop widths, accessibility (name, keyboard, focus,
   ARIA state) and every state (default, hover, focus, disabled, loading,
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
<!-- end: missing-primitive-steps -->

<!-- block: taxonomy-doc -->
Read the repo's `apps/storybook/TAXONOMY.md` and follow it for every story
the session adds, moves, renames or touches; that doc is the authority, so its
rules are not copied here. The bare minimum:
<!-- end: taxonomy-doc -->

<!-- block: version-history -->
- Adding, moving or renaming stories is a Storybook release: the version bump
  and Version History entry the doc names, in the same change. A session is
  one release: exactly one new Version History entry, at the next version
  after the `version` in `apps/storybook/package.json` on the main it last
  synced, describing only what the session changed, with `package.json` bumped
  to match. Never add an entry for a version main does not have beyond that
  one, renumber or reword main's entries, or special-case a validator, test or
  key (a duplicate-key exception) so two entries can coexist. After a main
  sync, the session's entry moves to the next version after main's.
<!-- end: version-history -->

<!-- block: precedent-stories -->
The handoff inventory judges story files by the scheme of the session's base
(`storybookScheme`, read from that base's own Storybook sources). It blocks a
new story file titled under or tagged for a v1.0 root and any other edit or
move of a v1.0 story file (`v1Stories`, `storiesInV2Taxonomy`), and an
existing non-v1.0 one whose title changed (`retitledStories`,
`existingStoryTitlesKept`) unless the writer
recorded it as a replacement's entry with
`vibe-sessions.mjs story-replacement --worktree <wt> --path <story file> --replacement <component>`, and
`vibe-guardrails-reviewer` checks the placement. The base is the main the
session last synced, so the retitles a main import brought are never the
session's own. A compile-only repair of a
v1.0 file does not block; it is listed under `compileOnlyV1Repairs` for the
Engineering checklist. Where in that tree a story
goes, and which component owns it, is `vibe-storybook-decomposer`'s Placement
block: the repo docs where they say how, otherwise the structure a sibling
entity's precedent set, never its root or version. The "existing story files
in the same area" that the repo skill's `workflows/author-stories.md` step 1
says to match are the stories for the same capability that block reports, read with
`apps/storybook/TAXONOMY.md`, never the neighbors in the same folder.
<!-- end: precedent-stories -->

<!-- block: bundled-tokens -->
- Before writing or accepting any hardcoded color, shadow or dark-mode
  override, read the tokens the touched surface actually bundles: each
  stylesheet it loads or inlines (for app and Desktop screens,
  `packages/design-system/styles/globals.css`; for a static or generated page,
  the CSS its generator writes or inlines) and, in each, its `:root` block and
  its `.dark` (or `prefers-color-scheme: dark`) block. Search them for the
  property's token family (`--shadow-`, `--color-`, `--radius`, and so on).
<!-- end: bundled-tokens -->
