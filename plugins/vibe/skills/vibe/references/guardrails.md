# Guardrails

Vibe work is reviewed by design and engineering, whether the person takes it
to a pull request themselves or passes it on for them to open one. It must already follow the team's patterns so they extend it
rather than rewrite it. The repo's `AGENTS.md` files are the contract; read
the nearest one before editing a directory. This file adds the rules specific
to vibe sessions and points at the repo rules that matter most here.

## Plugins and tooling

This rule binds the vibe and handoff orchestrators and every worker, in
Codex and Claude Code, and this section is its one canonical statement:

- Never install, update, reinstall, uninstall or repoint a plugin, change a
  plugin marketplace, or modify a plugin cache. The one exception is the
  vibe update the person chooses when the startup version check finds a
  newer release (`SKILL.md`, section 1, "Plugin version"): the orchestrator
  runs exactly the update commands `plugin-version.mjs` printed, and nothing
  else.
- Never clone or vendor the plugin's own repository (claude-plugins) to run a
  different version of its tooling.
- When continuing needs a fix to the vibe tooling, stop. It is never a
  question for the person.
  1. Record the blocker: the request stays `BLOCKED` in the session ledger
     with the reason, and a line in the live ticket's Progress names it.
  2. Report it to engineering: tell the person in one plain line that this
     needs engineering and to message engineering, naming this work by its
     summary (`plain-words.md`).
- A handoff check that also fails on the main the session captured is not a
  needed fix and never stops the handoff: it is a Known main failure recorded
  for engineering (`quality-loop.md`, "Failures already on main").
- Writer migration through `writer-state.mjs migrate` (`quality-loop.md`,
  "Recorded definition migration"), including a turn stranded by a plugin
  upgrade, stays allowed, but only after a human or
  the engineering orchestrator installed the new release. It is recovery, not
  a tooling fix: never stop or send the person to engineering for it.

## Processes and state

These rules bind every worker in both harnesses.

- Stop only a pid this session recorded and still owns: record each process
  you start with `node <plugin root>/hooks/kill-guard.mjs own <pid>`.
  Never `pkill`, `killall` or `kill` by name or pattern; in Claude Code that
  hook refuses them and a `kill` of a pid of 1 or lower or an unrecorded pid.
  Report what you did not start.
- Records, writer state, briefs, monitor config and reports a later step
  reads live in the session's Git metadata, `.claude/worktrees/` or
  `~/.codex/vibe/`, never `/tmp` or the system temp folder.
- In Codex, no computer use: no Computer Use plugin or agent looks through
  the in-app Browser, and GitHub only through `gh`. Visual checks go to
  read-only `vibe-verify-worker` through the owned Claude launcher, or are
  recorded as not run, their criterion `not met yet`.
- A visual check handed to another worker is a written request made after
  the push: the pushed head (never a local SHA), URLs or story IDs, flags,
  steps, expected result and criterion. Findings go to the SAME writer.

## What may change

For an owned `prototype/<slug>` mockup session, the repository's canonical
`<repo-root>/.claude/skills/prototype/SKILL.md` owns sandbox rules instead of
the full-app rules in this section. Its allowed host paths are exactly
`apps/prototypes/app/p/<slug>/`, the generated registry, and the exact portable
surface allowlist in `apps/prototypes/scripts/check-catalog-imports.mjs`.
The shared surface and stories still follow their owning package rules. Mock
state stays in the sandbox adapter; no backend stubs, seeded/blank environment,
or production flag snapshot is added. Only a branch-matching private session
record admits this path. All copy, reuse, accessibility, and forbidden-file
rules still apply.

Every session builds the real thing, frontend and backend: a screen that needs
data or an action the API does not provide gets that backend built by the SAME
persistent `vibe-change-worker`, using read-only backend guidance. A session that needs no new
data changes only frontend paths. Unless the person asks for a pull request,
it ends on the session's branch: design reviews it, then an engineer opens
the pull request and reviews it before it merges. When the person asks for
one ("Tests"), handoff opens the pull request for them to take through review
and merge.

| Frontend (the sole persistent `vibe-change-worker`) | Never |
|---|---|
| `apps/app/**` (web pages and route shells) | `apps/mcp/**`, `apps/relay/**`, `apps/realtime/**` |
| `packages/app/**` (shared web and Desktop UI) | `packages/golden-sessions/**`, `.github/**`, `apps/web/content/docs/**`, `docs/**` |
| `packages/design-system/**` (primitives, tokens, stories) | `scripts/**` (one exception below) |
| `apps/desktop/src/renderer/**` (Desktop UI) | any `AGENTS.md` or `CLAUDE.md` |
| `*.stories.tsx` anywhere above, and all of `apps/storybook/**` (below) | `apps/desktop/scripts/**` (Desktop's build and asset generators) |

All of `apps/storybook/**` is Storybook wiring the writer may edit: story
files, the `.storybook/` config (`main.ts`, `preview.tsx`, `manager.ts`,
decorators, toolbar globals), `TAXONOMY.md`, and `apps/storybook/scripts/`
(catalog sync and the taxonomy classification sets "Missing primitives"
below has the writer edit). Its `AGENTS.md` and `CLAUDE.md` stay off limits
like every other, its story validators are checks ("Checks", below), and its
test files follow "Tests". The `scripts/**` in the Never column is the
repo-root `scripts/` folder, never `apps/storybook/scripts/`.

`apps/desktop/scripts/**` is in the Never column explicitly: no column listed
it, so it already fell outside the allowed paths, and a static Desktop page's
asset generator lives there. Nothing about it changes: the handoff inventory
still reports it under `outsideAllowed`, and a request that needs it takes the
forbidden-path route below (`Engineering needed (forbidden path)`), never an
edit in the session.

Nothing agent-written goes into public docs. No worker edits
`apps/web/content/docs/` or the internal `docs/` folder, in any phase;
"Feature docs at handoff" below says what handoff records instead.

Backend, built by that same writer using canonical backend guidance, each under its owning
`AGENTS.md`:

- `apps/api/**`: thin route, fat service, `withAnyAuth`, Zod validation, org
  scoping on every query, the `Result` error model (`apps/api/AGENTS.md`).
- `packages/api/src/types/**`: shared request and response types, the one
  canonical place for them.
- `packages/database/**`: Prisma schema changes with a generated migration
  (`packages/database/AGENTS.md`); never edit a migration that has landed on
  main; never apply a migration to a shared database from this Mac; every new
  model gets a seed coverage file and seed data in the vibe seed. Pushing a
  migration publishes it to shared preview schemas, so record the test that
  runs it as `Migration test:` (an existing one that applies every migration
  counts; for per-row work a measured `Scale test:` too) first;
  `scripts/migration-publish.mjs` refuses the push without them.
- `apps/desktop/src/main/**` and `apps/desktop/prisma/**`, when the change is a
  Desktop feature (`apps/desktop/AGENTS.md`; gateway operations stay in
  `apps/desktop/src/server/operations/`).
- One living session decision table stays local in
  `.closedloop-ai/decision-tables/<session-slug>.md` (gitignored in this repo).
  It is mandatory before code for every request, with stable row IDs, and
  verified afterward by the SAME writer under quality-loop.md; it is not
  backend-only. Handoff attaches it to the live ticket so the reviewing
  engineer sees whole-session behavior and actual coverage evidence.

The build loop stays lean (`quality-loop.md`, "Lean build loop"):

- The loop is quick prep, the build, the quick checks the commit hooks need,
  the orchestrator's commit, deploy, and showing the person.
- Beyond the quick checks, the loop's only other check is the writer's
  acceptance check before a change is called ready (`quality-loop.md`,
  "Acceptance criteria before ready"): one cheap existing test, script,
  control read or source trace per touched criterion, never a suite or QA
  pass.
- Reviews and heavy validation run at handoff: the guardrails and
  adversarial reviews, browser E2E, visual QA, logical QA, product-contract
  QA, the targeted existing tests (the ones `code_tests_for` returns for each
  changed file, never a full suite) and two review passes when backend code
  changed, the running web app and Desktop driven with the repo's control
  skill, and the list of tests engineering still has to write (Tests, below).
- Outside the loop, visual QA also runs during the session when the person
  accepts it or asks for polish (`quality-loop.md`, "Visual QA during the
  session").

One exception under `scripts/`: the source-gate allowlist
(`scripts/lint/source-gate-allowlist.json`) is shrink-only, so when the
session's change removes the last allowlisted occurrence of a rule (or some
of them), delete that entry or lower its count. That is the only `scripts/`
edit a session may make; the handoff inventory checks mechanically that the
file only lost entries or counts, and reports anything else under `scripts/`.
It applies wherever the session's work is checked or pushed (a change
worker's self-check or fix mode, a redeploy, the first push, handoff): when
`pnpm check:source-gates` or the pre-push hook reports a stale entry (for
example "pins count 1, but only 0 remain") for a file the session changed,
delete the entry (0 remain) or lower its count to what remains, and run the
gate again. Never add an entry or raise a count; a new violation is fixed in
the code.

When a request genuinely needs a change in a Never path beyond that one
exception (a source gate under `scripts/**`, a workflow under `.github/**`, a
rule in an `AGENTS.md`), that part is engineering's. The writer never edits
the path and never builds a substitute for it in an allowed path, such as a
copied gate or a workflow step moved into a package script. It logs the need
in the session change log as
`Engineering needed (forbidden path): <path or area>; why: <need>` and keeps
building every allowed part of the request. The need is not `BLOCKED`, not a
question for the person, and never stops the session; the ticket worker
carries each one to the live ticket's Engineering checklist
(`ticket-template.md`, "Engineering needed"). The same holds for a path
outside the allowed table: the writer does not edit it in the loop either.
A visible part of the request that needs such a path keeps its acceptance
criterion `not met yet` with the reason that engineering must make it, and
the ready message tells the person so in plain words, so they never accept a
change the branch cannot keep. A fix to vibe's own tooling is
different and still stops the session ("Plugins and tooling", above).

Vibe work is headed for `main`, so the target repo's flag rule decides which
keys it may add ("Feature flags"). If the person chose Labs, the Labs pattern
is that flag. Tell them in one line that the new screen stays hidden on their
environment until that flag is turned on for them.

The prototype-first rule in the root `AGENTS.md` (net-new screens start in
`apps/prototypes`) does not apply to vibe sessions. Build in Storybook and
app code directly.

## Where code goes

- Generic, domain-free UI (a control, layout, token) belongs in
  `packages/design-system`. Domain UI (projects, sessions, branches,
  documents) belongs in its feature slice in `packages/app/<feature>/`
  (`components/`, `hooks/`, `lib/`). `apps/app` keeps route shells.
- Domain code never goes in `packages/design-system`; `biome.jsonc` blocks it.
- Add a new control to the surface that already owns that entity or flow
  (same tab, drawer, dialog, or card) instead of a parallel page.
- For any component that composes or inherits from a shared parent,
  behavior the children share goes in the parent as a generic, domain-free
  slot or extension point, and a child keeps only what is specific to that
  child. The domain wiring stays in the owning feature package, and each
  child opts in instead of reimplementing it. Never copy an existing shared
  component. `design-pass.md` has the owner rules, the build loop's
  prep step, and what the quality reviewers check at handoff.

## Reuse first

Before building anything, search
`packages/design-system/storybook/component-catalog.ts` and `packages/app` for
a component that already renders the concept, and use it. Follow the paved
paths in `packages/app/AGENTS.md`, such as the shared list surface with its
pagination and header, and the shared date formatting helpers. Read `.claude/design/discipline-core.md` once per session; it is the
team's design standard.

## Missing primitives

When nothing in the catalog fits:

1. Keep the missing building block internal and add it to the reviewed local
   plan. Do not narrate this technical dependency to the person; the only
   message about it is the new-components notice in step 5.
2. Run the repo agent `design-system-steward` (`.claude/agents/design-system-steward.md`)
   with the need. Follow its answer, which is one of three:
   - Reuse: an existing component covers it. Use it and continue.
   - Extend: add a variant or prop to an existing component. Never change an
     existing default; add the new behavior beside it.
   - Create: a new component, placed where the steward says. Generic and
     domain-free goes in `packages/design-system/components/ui/`; domain UI
     goes in its feature slice under `packages/app/<feature>/components/`.

   For Extend and Create, the spec must cover the whole component, not only
   the case this screen needs: every variant and size, responsive behavior at
   phone and desktop widths, accessibility (accessible name, keyboard
   behavior, focus handling, ARIA state), and every state that applies
   (default, hover, focus, disabled, loading, empty, error). Ask the steward
   for whatever its answer leaves out before building. Any text a state shows
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
5. A new component is built with its stories before the feature that uses it.
   The orchestrator points the person to its stories on local Storybook in one
   plain message and does not wait (`SKILL.md`, section 5, "Notices that never
   wait"); the person may interrupt to change it.
6. Use it in the screen without waiting for a reply.

## Storybook taxonomy

Read the repo's `apps/storybook/TAXONOMY.md` and follow it for every story
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
    descriptive, permanent and without a version number.
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
  after the `version` in `apps/storybook/package.json` on the main it last
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
`apps/storybook/TAXONOMY.md`, never the neighbors in the same folder.

## Tokens and styling

No hardcoded colors, arbitrary pixel values, or ad-hoc dark-mode overrides.
Annotation "Adjust" values arrive as raw CSS (a hex color, a pixel size); map
each one to the nearest existing token or spacing step internally. If no token
is close, raise it as a missing primitive.

### Check the bundled tokens first

This section is the rule's one canonical statement; the writer and the
guardrails reviewer point at it.

- Before writing or accepting any hardcoded color, shadow or dark-mode
  override, read the tokens the touched surface actually bundles: each
  stylesheet it loads or inlines (for app and Desktop screens,
  `packages/design-system/styles/globals.css`; for a static or generated page,
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

## Copy

The person is the author of user-visible words. Use their words verbatim, or
reuse an existing string or label map. Never compose a label, button, empty
state, tooltip, error, or helper text yourself. Before asking for missing words,
apply `quality-loop.md`'s graph-first product research and necessity gate.
There is no exception: product docs pages are user-visible words too ("Feature
docs at handoff").

Wording the product already renders is reused through its helper, never
retyped. Before writing any label, count or selection wording (for example
"3 selected"), `rg` the words and the helpers that build them in
`packages/app/shared` and the owning feature package; a second spelling of a
string a shared helper already produces is a copy (`design-pass.md`, "Red
flags"), even when the words match.

## Feature docs at handoff

Nothing agent-written goes into public docs.
This section is the rule's one canonical statement; the writer, the guardrails
reviewer, the ticket worker and the handoff skill point at it.

- No worker edits, creates or drafts anything under `apps/web/content/docs/`
  (product docs pages, `meta.json`, generated pages) or the repo's internal
  engineering `docs/` folder, in the build loop, at handoff or in a requested
  pull request. Docs belong to the humans who review and finish the work.
- At handoff the same writer only records which existing product docs pages
  describe a changed feature, found by searching that folder for the changed
  screens, routes, components, flags and FEATURE_MAP ids, with the passage
  that no longer matches what was built. The ticket's Feature docs line lists
  them for design or engineering to update; it never carries drafted words.
  When no page covers a changed feature, record that.
- The handoff inventory reports any change under either folder as outside the
  allowed paths in every phase. An edit found there is removed by the same
  writer and recorded on the Feature docs line instead, never kept as a
  draft.

## No new tech debt

A change grows no tech debt without a cited reason. A new flag key, a
parallel path (a second route, service, writer or store for a behavior one
already owns), a shim, re-export or code kept only for a deprecated story, a
second owner, a duplicated helper, type, constant, validator or bound, new
config, or growth of a file near the repo's size ceiling needs a human source
or a quoted repo rule; otherwise reuse what exists.

The writer logs each one; its own rationale is never the reason. Required
log line:
`Debt: <kind>; added: <what>; reused instead: <what>; reason: <source>`

Flags are the tested case below.

## Feature flags

No agent creates or adds a flag on its own.

- Propose a key, or a new read of one, only for what the target repo's own
  flag rule allows, quoted from its `AGENTS.md`, with a human source; what
  that rule ships directly is built ungated. One behavior gets one key
  (rollout states are its values), one key covers web and Desktop, and a key
  already gating the surface, on main or in another session's
  `vibe-sessions.mjs list` entry, is reused.
- Record proposals and every key the work sits behind with
  `scripts/flag-keys.mjs record`, then return `NEEDS_FLAG_APPROVAL`. The
  person approves each key: ask the exact words `flag-keys.mjs question`
  prints (the key, why, what it gates, the whole stack) and record the answer
  with `approve`. Only an explicit yes builds the key; no answer or nobody to
  ask builds nothing. The script's messages give the fields and next steps.
- The ticket's Production flag snapshot section shows "Keys to see this work"
  from the record, handoff tells the person, and `live-ticket-check.mjs`
  fails an unapproved key.
- An agent never adds or edits a flag registration attestation (a ledger row
  or verification date only a human makes); the
  approval and "Keys to see this work" tell the human which key to ledger.

## Accessibility

Icon-only controls get accessible names, disclosures get `aria-expanded`, one
`<main>` per page, and state is never conveyed by color alone.

## Labs

Default: no flag. When the person asks for Labs, follow the repo's existing
Labs destination pattern: the route checks the repo's Labs container flag
plus its own PostHog key, as an existing Labs destination does. One key gates
web and Desktop.
Tell them the Labs entry shows on their environment only if those flags are
on for them; both keys follow "Feature flags".

## Tests

No worker authors a test in vibe or handoff: no new `*.test.*` or `*.spec.*`
file, nothing new under `__tests__/` or `e2e/`, no new case, assertion,
snapshot or fixture, and no deleted test of live behavior. This holds in the
build loop and at handoff alike. The edits
allowed are a repair and a retired-only deletion, below. Existing tests run
at handoff, and stories remain part of component work.

Never ask the person about tests or any other engineering choice. These rules
decide it, or it goes to engineering, never to the person.

### Repair, don't author

When the session's own change breaks an EXISTING test or test fixture (an
import, a renamed or retired symbol, setup, a type error), the SAME persistent
`vibe-change-worker` mechanically updates that existing file so the tree
compiles and the commit hooks pass, in the build loop or at handoff. A repair never
changes what any test asserts: no weakened or deleted assertion, no changed
expected value or snapshot, no new skip, no loosened matcher, tolerance or
timeout. It adds no test file, no case and no coverage; new tests still go on
Missing tests. The writer records each repaired file in the session change log
as a repair, with the symbol or setup it followed. The handoff inventory lists
repairs under `testRepairs` and reports an added or deleted test file, or a
changed snapshot, as outside the allowed paths; `vibe-guardrails-reviewer`
checks that every repair left each assertion unchanged.

When the only way to make a test compile would change what it asserts, that
is not a repair. If the test covers only code the request retires, delete it
as below; otherwise the test stays unedited, goes on Missing tests, and the
blocked commit goes to engineering.

### Retired-only tests may be deleted

The SAME writer may delete a test file or test case that covers ONLY code the
request itself retires, citing the ticket or PRD that retires that code (the
root `AGENTS.md`: "When the contract under test is deliberately retired,
deleting its test is the complete and correct outcome"). A test that still
covers any live behavior is only repaired, never deleted;
when one file mixes both, delete only the retired cases and repair the rest.

Record every deletion before the commit:

```
node <plugin-root>/skills/vibe/scripts/retired-tests.mjs record --worktree "<wt>" --path <test file> [--case "<test name>"] --retired-by <ISS-, PRD- or FEA- slug> --covers "<retired code it covered>"
```

The handoff inventory admits a deleted test file outside a pull request only
with that whole-file record and lists every recorded deletion under
`retiredTests`; `vibe-guardrails-reviewer` verifies each one covered only
retired code, and the live ticket lists them on its Retired tests deleted line
next to Missing tests so engineering sees them.

### Running and missing tests

Handoff runs the existing affected tests: after any change, fix or main
merge (a conflict resolution included), exactly the tests closedloop-graph
`code_tests_for` returns for the files it touched, plus the inventory's
`diffRules.requiredTests`, nothing broader by default. Files that map to no tests
(changelog, README, version text, Storybook Version History) run none; CI
confirms them. When one fails, the SAME persistent
`vibe-change-worker` fixes the session's own code, never what the test asserts
(a broken import or setup is a repair, above). Coverage
the session still needs is recorded internally as it is found and, at
handoff, listed on the live ticket under Missing tests as engineering's scope
of work: each behavior and stable row ID that needs a test, and the files to
cover (`ticket-template.md`). Engineering writes those tests in its pull
request, alongside the tests for every frozen row.

The only exception: when the person explicitly asks for a pull request to be
raised, full tests for every change in the session are required before it
opens. That request is the only thing that authorizes test writing, and only
the SAME persistent writer writes them, in an explicit `pull-request` turn.
Verify, backend, primitive, prototype and Storybook helpers never author
tests. Record phase, criteria and test paths in the session change log so
reviewers can tell those tests from forbidden test changes.

The person asks in plain words, and plain-language intent to take the work
through review and merge themselves IS that explicit request. Words such as "raise a PR", "open a pull request", "I'll get the
PR merged", "I'll get it merged", "I'll ship it myself" and "I want to take it
through review" all ask for a pull request and take handoff's requested pull
request path, as does choosing the pull request in handoff's question about
how the session ends. Nothing else does: the rule that tests are written only
on that request is unchanged. Never offer to send the person the branch to
merge; a bare branch is not something they can act on.

Do not create source writers per unit, specialty or fix, or additional feature
worktrees/branches. Setup helpers never patch implementation code or add a new
local code workaround. The SAME persistent writer owns managed local
workarounds under their bug tickets, following `quality-loop.md`; existing
and new `localFixes` retain their exclusion and restore rules.

Preserve test integrity. A red test is a failing expectation: fix code when its
contract still stands. When the exact human behavior ruling that the repo's
Test Modification Guardrail asks for makes an expectation obsolete, the test
stays unedited: record that ruling and list the test under Missing tests for
engineering to update, retaining coverage of every still-live contract.
Never loosen, skip or remove a valid test, edit a fixture or harness to mask a
failure, or raise timeouts/tolerances to get green; a repair only keeps an
existing test compiling, and a recorded retired-only deletion removes only a
test whose code the request retired. Neither vibe nor handoff opens a pull
request on its own.

## Checks

Never add a check nobody asked for: a new gate, validator, lint rule, CI
step or repo-wide test, or a shared test helper widened to support one, that
the ticket, its PRD or the person did not ask for is instruction inflation.
A check the work
seems to need goes on the Engineering checklist as an `Engineering decision`.

Never make a failing check pass by changing the check: test assertions and
expected values, snapshots, tolerances, skips, timeouts, coverage or size
thresholds, lint and type suppressions (`biome-ignore`, `@ts-expect-error`, a
cast that only quiets the compiler), a raised allowlist count, or the harness.
Fix the code. The shrink-only allowlist edit above, a test repair that leaves
every assertion unchanged, a recorded retired-only test deletion and the repo's explicitly human-directed
behavior-change rule in Tests are not ways to hide a failure.
If an expectation looks wrong without that evidence, keep it and report it.

## Repo rules that bite most often

The code style rules in the root `AGENTS.md` bind every edit; the Biome and
source gates enforce most of them. After each batch of edits run
`pnpm exec biome check --write <changed files>`.
