# Provider text for agents/vibe-storybook-decomposer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: storybook-docs -->
Read `apps/storybook/AGENTS.md` for
where stories must live to be collected, and the repo's
`apps/storybook/TAXONOMY.md`, which places every new story: a current root,
its page tree, one lifecycle tag and the release bump, never a frozen v1.0
root (`../skills/vibe/references/guardrails-ui.md`, "Storybook taxonomy"). Read
that doc as the session's base has it: on a base older than the lifecycle
scheme it still places new work under `<Level> v2.0/` with the `v2.0` tag. An
existing component's story file keeps its title and tag ("Precedent search",
step 4).
Read the same session decision table and affected/interacting row IDs. Use
those states and invariants when advising on stories or extraction; the sole
writer adds missing rows before code and verifies preservation afterward.
Do not author another table, source or test; planned tests go on the missing
tests list for engineering at handoff.
<!-- end: storybook-docs -->

<!-- block: graph-required -->
closedloop-graph is required, per `../skills/vibe/references/closedloop-graph.md` (relative to this file): `code_symbols` to find existing stories and similar components to match, `code_importers` on each precedent's providing component to list its hosts, and `code_callers` and `code_importers` before extracting a component so every import site is updated. End your report with the Graph block.
<!-- end: graph-required -->

<!-- block: precedent-search -->
2. Find every place the same capability already exists for a sibling entity
   (another entity's list or detail surface): `code_symbols` on its names
   and `code_importers` on the component that provides it, then the built
   Storybook index, not a title grep. Read `<storybookUrl>/index.json` from the session's running local
   Storybook (`vibe-sessions.mjs show`); when none runs, read
   `packages/design-system/storybook/component-catalog.ts` and the story
   files on main. Match story names as well as titles, and every story file
   that renders the providing component or passes the capability's prop.
   Leave out the session's own stories.
<!-- end: precedent-search -->

<!-- block: placement-rules -->
4. Decide in this order.
   - First: a change to an existing component (new states or variants, an
     extra column action, a new footer) never retitles, re-tags or moves its
     existing story file. Storybook builds story IDs from the title path, so
     a retitle breaks every link to those stories.
     - A v1.0 story file (under a `<Level> v1.0/` root or tagged
       `deprecated`) is frozen and never edited, not even to add a story: the
       new states go in a new entry for that component in the current root
       holding only the new states, its name descriptive, permanent, per
       `apps/storybook/TAXONOMY.md` and without a version number, with the
       lifecycle tag its place in the tree takes, and the v1.0 stories stay
       where they are.
     - The one exception is a compile-only repair after a rename elsewhere:
       only mechanical changes (prop renames, imports, types), no story added
       or removed, no title, story ID or tag change and no visual change,
       since the freeze protects what its stories show and their links, not
       the code wording.
     - Story files under the `Start Here/` root are exempt from the v1.0
       freeze and the title, tag and retitle checks: Start Here is
       unversioned and its Version History is edited by every Storybook
       release.
     - Any other existing story file takes the new states as extra stories,
       its title, tag and existing story names unchanged.
     - Otherwise only a new component, or a sibling replacement such as a V3,
       gets a new entry and a place in the current roots.
     - This outranks reading a touched story file as moving to the current
       roots or taking a new lifecycle tag.
   - Then: where the repo's `apps/storybook/TAXONOMY.md` or
     `.claude/skills/storybook/` already say how, follow them; where they do
     not, mirror the precedent: the same owner, the same way of consuming it,
     the component that carries its stories, how granular they are and which
     states get variants. Mirroring copies structure only, never location or
     lifecycle: the root, lifecycle tag and tree position always come from
     `apps/storybook/TAXONOMY.md`, and a precedent in a v1.0 root never puts
     new work in v1.0.
   - The lifecycle tag of a new entry also follows its flags (operator ruling,
     2026-10-27): list each PostHog flag that gates the surface where it is
     mounted and each flag the planned stories turn on
     (`parameters.appCore.enabledFlags`, a desktop page's `flags` prop), and
     read each one's value in the session's production flag snapshot (the
     file at `flagSnapshot.file` in `vibe-sessions.mjs show`). A surface
     reachable only behind a flag that is off or missing there gets the
     `preview` tag wherever it sits in the tree, never `stable`, and its story
     file names that flag the way the repo's `apps/storybook/TAXONOMY.md`
     says (a `// Preview: <flag key> is off in production` comment). With no
     snapshot on the session the tag cannot be decided: report it as a
     Conflict for `engineering`.
   - Either way, stories document the components consumers actually render,
     one story per state, never internal render pieces: a shared capability's
     generic mechanics stay in the shared component's existing stories, and
     the page-level component consumers render gets variants showing only its
     domain-specific configuration (its dimensions, labels, icons). It fits
     the doc's Composites row, "a section of a page".
   - A whole-page flow (the page a route renders, or several sections
     composed into one flow) is never a Composite entry: it goes in named
     `Surfaces/` stories for that page, per the doc's Surfaces row.
<!-- end: placement-rules -->

<!-- block: placement-citation -->
Never invent a placement: every Owner and Stories line cites the
`apps/storybook/TAXONOMY.md` or `.claude/skills/storybook/` section, or the
precedent path, it follows.
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
   test (`../skills/vibe/references/guardrails.md`, "Tests").
<!-- end: location -->

<!-- block: frozen-base -->
- Frozen renders: run `../skills/handoff/scripts/frozen-render.mjs --repo
  <worktree> --base <base> --base-dir <prepared base worktree> --story-file
  <file> ... --out <dir>` once with every story file the inventory's
  `frozen-render` finding lists, never a capture of your own. The base URL
  is the repo's Storybook served from a disposable worktree made by
  `../skills/handoff/scripts/frozen-render.mjs prepare-base --repo <worktree>
  --base <base> --story-file <file> ... --dir <dir>` with the same story
  files, bootstrapped with `.closedloop-ai/loops-setup.sh` and removed
  afterwards (`git worktree remove`); never copy or edit a file in it
  yourself. It is the base commit with each compile-only repaired story file
  (same title, tags and story names) taken from the session, so a repaired
  play runs on both sides and only the app code differs. The renderer starts
  the head and base servers itself with the owned run wrapper, derives the URLs,
  and stops both before the base worktree is removed. It is heavy
  validation and runs under the same load and slot rules as every other
  handoff heavy run. It renders each story twice on the base and once on the
  branch with its clock, animations, viewport, fonts, theme, args and globals
  pinned, waits for each play to finish and judges it with
  `story-play-verdict.mjs`. It prints one line per story and a summary; read
  those and, for a `blocking` story, only its cropped diff, never the full
  screenshots. Each `blocking` story is a finding. A `same-failure` story
  fails the same way on the base and an `unstable-on-base` story renders
  differently on two base renders: neither is a finding, and each goes on the
  live ticket as a Known main failure. A story the run marks `head story
  file on both sides` was compared with the session's repaired story file;
  a story file changed beyond a compile-only repair is not compared and
  its stories block. When nothing blocks, report the
  `Frozen render unchanged` line it prints for the writer to record
  unchanged; never write or edit that line yourself. Each finding and its
  remedy (make a story deterministic, pause an animation) is for the writer,
  or for engineering on the ticket when the session may not make it; never
  phrase it as something the person running the session does
  (`../skills/vibe/references/plain-words.md`, "What the person is asked to
  do"; ISS-13321).
<!-- end: frozen-base -->

<!-- block: version-history -->
- Version History: the session's new entries in `Start Here/Version History`
  against the base's `apps/storybook/package.json` `version`; anything but
  one entry at the next version is a finding.
<!-- end: version-history -->
