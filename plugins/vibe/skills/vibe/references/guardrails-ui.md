# Guardrails: UI rules

<!-- provider-rule -->
Lines that start `> Provider` follow `references/provider-text.md`.
<!-- end provider-rule -->

Moved out of `guardrails.md`, which says when to read it; later edits to that text land here. Markdown links are relative to this file; other paths stay relative to the skill folder.

<!-- block: ui-rules -->
## Missing primitives

When nothing in the catalog fits:

1. Add the missing building block to the local plan; the person hears of it
   only through the new-components notice in step 5.
<!-- generic: missing-primitive-steps -->
2. Decide reuse, extend or create from the repository's component catalog and
   its design-system docs (or a design-system agent or skill the repository
   ships, given the need):
<!-- end generic: missing-primitive-steps -->
> Provider `recipes` (block `missing-primitive-steps` of `vibe/guardrails-ui.md`)
   - Reuse: an existing component covers it. Use it and continue.
   - Extend: add a variant or prop to an existing component. Never change an
     existing default; add the new behavior beside it.
<!-- generic: missing-primitive-steps-2 -->
   - Create: a new component, placed where the repository's docs put shared,
     domain-free UI and where they put its feature UI.
<!-- end generic: missing-primitive-steps-2 -->
> Provider `recipes` (block `missing-primitive-steps-2` of `vibe/guardrails-ui.md`)

   For Extend and Create, the spec covers the whole component: every variant
   and size, phone and desktop widths, accessibility (name, keyboard, focus,
   ARIA state) and every state (default, hover, focus, disabled, loading,
<!-- generic: missing-primitive-steps-3 -->
   empty, error). State text follows the Copy rules below.
3. Build it to the repository's Storybook and design-system rules (their
   `AGENTS.md` files and any Storybook skill it ships): stories go where
   Storybook collects them and follow "Storybook taxonomy" below, and a
   catalog the repository generates is refreshed with its own command, never
   edited by hand. Its tests are not written in the session; handoff lists
   them for engineering (Tests, below).
4. Run the Storybook tests for the new or changed story files only, with the
   repository's own Storybook test command, never the whole suite, and
   confirm the new stories pass.
<!-- end generic: missing-primitive-steps-3 -->
> Provider `recipes` (block `missing-primitive-steps-3` of `vibe/guardrails-ui.md`)
   A story or play that requests a viewport uses a MINIMAL_VIEWPORTS name
   (`mobile1`, `mobile2`, `tablet`, or `desktop`) or a name actually registered
   in `parameters.viewport.options`. Handoff's Storybook diff rule blocks an
   unregistered name before the play can be counted as responsive evidence.
5. A new component is built with its stories before the feature that uses it.
   The orchestrator points the person to its stories on local Storybook in one
   plain message and does not wait (`SKILL.md`, section 5, "Notices that never
   wait"); the person may interrupt to change it.
6. Use it in the screen without waiting for a reply.

## Storybook taxonomy

<!-- generic: taxonomy-doc -->
Read the repo's Storybook taxonomy document (when it has one) and follow it for every story
<!-- end generic: taxonomy-doc -->
> Provider `recipes` (block `taxonomy-doc` of `vibe/guardrails-ui.md`)
the session adds, moves, renames or touches; that doc is the authority, so its
rules are not copied here. The bare minimum:

- New stories go in the current roots, titled under the plain level
  (`Foundations/`, `Primitives/`, `Composites/`, `Patterns/`, `Surfaces/`),
  never in the frozen v1.0 roots (`Foundations v1.0/`, `Primitives v1.0/`,
  `Composites v1.0/`, `Surfaces v1.0/`), whose story files are all tagged
  `deprecated`.
- New states or variants of an existing component never retitle, re-tag or
  move its existing story file, since story IDs come from the title. Where
  they go (`vibe-storybook-decomposer.md`, "Precedent search" step 4):
  - A v1.0 story file (under a `<Level> v1.0/` root or tagged `deprecated`)
    is never edited beyond a compile-only repair (prop renames, imports,
    types; no story, title, tag or visual change): its component's new
    states go in a new entry in the current root holding only them, its name
    descriptive, permanent and without a version number. Preserve its level
    while dropping only the frozen version marker, so
    `Composites v1.0/...` becomes `Composites/...`.
  - A compile-only repair rewords no comment, description, docs parameter or
    story text either: a renamed identifier inside prose is its only prose
    change.
  - Any other existing file takes them as extra stories, its title and tag
    unchanged.
  - Otherwise only a new component or a sibling replacement (a V3) gets a new
    entry.
- Story files under the `Start Here/` root are exempt from the v1.0 freeze
  and the title, tag and retitle checks: Start Here is unversioned and its
  Version History is edited by every Storybook release.
- Composites, Patterns and Surfaces are placed in the page tree the doc
  describes.
- Each story file carries exactly one lifecycle tag in its own meta, per the
  doc's "Lifecycle": `stable` for a shipped surface, `preview` for anything
  under `Labs`, `experimental` for a design-only preview or anything under
  `Not In The Live App`; never `deprecated`, which only the v1.0 roots carry.
  A story that differs from its file overrides it per story
  (`tags: ["!stable", "experimental"]`).
- Adding, moving or renaming stories is a Storybook release: the version bump
  and Version History entry the doc names, in the same change. A session is
  one release: exactly one new Version History entry, at the next version
<!-- generic: version-history -->
  after the `version` in the Storybook package's `package.json` on the main it last
<!-- end generic: version-history -->
> Provider `recipes` (block `version-history` of `vibe/guardrails-ui.md`)
  synced, describing only what the session changed, with `package.json` bumped
  to match. Never add an entry for a version main does not have beyond that
  one, renumber or reword main's entries, or special-case a validator, test or
  key (a duplicate-key exception) so two entries can coexist. After a main
  sync, the session's entry moves to the next version after main's.
- Moving or retitling a story changes its ID: the inventory's
  `lost-story-id` findings name every reference left. One in a test or e2e
  spec is repaired in the same change (a renamed symbol, "Repair, don't
  author"); one in a path the writer may not edit is logged as
  `Engineering needed (forbidden path)`.
- A session whose base predates this scheme (Storybook before 3.0.0) follows
  that base's own `TAXONOMY.md`: there the plain roots and the `v1.0` tag are
  v1.0, and new work goes under `<Level> v2.0/` tagged `v2.0`. Syncing main
  moves it to this scheme: its own new entries then take the plain root and a
  lifecycle tag.

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
<!-- generic: precedent-stories -->
Storybook taxonomy document, never the neighbors in the same folder.
<!-- end generic: precedent-stories -->
> Provider `recipes` (block `precedent-stories` of `vibe/guardrails-ui.md`)

## Tokens and styling

No hardcoded colors, arbitrary pixel values, or ad-hoc dark-mode overrides.
Map an annotation's raw "Adjust" value to the nearest token or spacing step,
or raise a missing primitive.

### Check the bundled tokens first

This section is the rule's one canonical statement; the writer and the
guardrails reviewer point at it.

- Before writing or accepting any hardcoded color, shadow or dark-mode
  override, read the tokens the touched surface actually bundles: each
  stylesheet it loads or inlines (for app and Desktop screens,
<!-- generic: bundled-tokens -->
  the design system's global stylesheet; for a static or generated page,
<!-- end generic: bundled-tokens -->
> Provider `recipes` (block `bundled-tokens` of `vibe/guardrails-ui.md`)
  the CSS its generator writes or inlines) and, in each, its `:root` block and
  its `.dark` (or `prefers-color-scheme: dark`) block. Search them for the
  property's token family (`--shadow-`, `--color-`, `--radius`, and so on).
- A bundled token that delivers the property is used as `var(--token)`.
  Where such a token exists, a raw `rgb()`, hex or pixel value, a page-local
  custom property re-declaring its value, or a dark override of a value its
  `.dark` block already defines is blocking at handoff, never advisory.
- "Not bundled" is recorded per token, never per surface. Only a token the
  surface genuinely lacks may be logged as missing, with the evidence of the
  check. Required log line:
  `Engineering needed (token not bundled): <surface>; <token>; checked <each stylesheet and block searched>; uses <the token's exact value>`
- That property then uses the token's exact value with the token cited
  beside it, never a value no token defines, and every other property on the
  surface keeps its bundled token.
- A missing-token line without the stylesheets and blocks searched, or for a
  token that check finds, is a finding, and so is a wider claim such as "this
  page bundles no tokens" or "no elevation token exists".
No icon-in-a-colored-box chips, no borders on everything, no badge where a
plain string works.

## Making something look better

When the person asks to make something look better, change only the visual
layer: spacing, type, color tokens, alignment, and emphasis. Copy, information
architecture, and routes stay as they are unless the person asks to change
them.
<!-- end: ui-rules -->
