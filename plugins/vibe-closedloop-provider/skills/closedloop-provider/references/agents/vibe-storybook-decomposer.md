# Provider text for agents/vibe-storybook-decomposer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: storybook-docs -->
Read `apps/storybook/AGENTS.md` for
where stories must live to be collected, and the repo's
`apps/storybook/TAXONOMY.md`, which places every new story: a current root,
<!-- end: storybook-docs -->

<!-- block: graph-required -->
closedloop-graph is required, per `provider:closedloop-graph.md`: `code_symbols` to find existing stories and similar components to match, `code_importers` on each precedent's providing component to list its hosts, and `code_callers` and `code_importers` before extracting a component so every import site is updated. End your report with the Graph block.
<!-- end: graph-required -->

<!-- block: precedent-search -->
   (another entity's list or detail surface): `code_symbols` on its names
   and `code_importers` on the component that provides it, then the built
<!-- end: precedent-search -->

<!-- block: precedent-search-2 -->
   `packages/design-system/storybook/component-catalog.ts` and the story
<!-- end: precedent-search-2 -->

<!-- block: placement-rules -->
       `apps/storybook/TAXONOMY.md` and without a version number, with the
<!-- end: placement-rules -->

<!-- block: placement-rules-2 -->
   - Then: where the repo's `apps/storybook/TAXONOMY.md` or
<!-- end: placement-rules-2 -->

<!-- block: placement-rules-3 -->
     `apps/storybook/TAXONOMY.md`, and a precedent in a v1.0 root never puts
<!-- end: placement-rules-3 -->

<!-- block: placement-rules-4 -->
     file names that flag the way the repo's `apps/storybook/TAXONOMY.md`
<!-- end: placement-rules-4 -->

<!-- block: placement-citation -->
`apps/storybook/TAXONOMY.md` or `.claude/skills/storybook/` section, or the
<!-- end: placement-citation -->

<!-- block: catalog -->
4. Catalog and taxonomy. A new `packages/design-system/components/ui/*.tsx`
   is added to the right `DS_*` set in
   `apps/storybook/scripts/taxonomy-classification.mjs`. Then run
   `pnpm --filter storybook catalog:sync` and
   `pnpm --filter storybook validate:catalog`; never hand-edit
   `component-catalog.ts`.
<!-- end: catalog -->

<!-- block: location -->
5. Location. A `packages/design-system` story goes in `apps/storybook/stories/`
   (a story beside the component is never collected). Never write or edit a
<!-- end: location -->

<!-- block: frozen-base -->
  files, bootstrapped with `.closedloop-ai/loops-setup.sh` and removed
<!-- end: frozen-base -->

<!-- block: version-history -->
  against the base's `apps/storybook/package.json` `version`; anything but
<!-- end: version-history -->
