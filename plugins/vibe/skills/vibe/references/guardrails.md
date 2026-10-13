# Guardrails

Vibe work is handed to design and then engineering, who review it and open
the pull request. It must already follow the team's patterns so they extend it
rather than rewrite it. The repo's `AGENTS.md` files are the contract; read
the nearest one before editing a directory. This file adds the rules specific
to vibe sessions and points at the repo rules that matter most here.

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
data changes only frontend paths. It still ends on the session's branch:
design reviews it, then an engineer opens the pull request and reviews it
before it merges.

| Frontend (the sole persistent `vibe-change-worker`) | Never |
|---|---|
| `apps/app/**` (web pages and route shells) | `apps/mcp/**`, `apps/relay/**`, `apps/realtime/**` |
| `packages/app/**` (shared web and Desktop UI) | `packages/golden-sessions/**`, `.github/**` |
| `packages/design-system/**` (primitives, tokens, stories) | `scripts/**` (one exception below) |
| `apps/desktop/src/renderer/**` (Desktop UI) | any `AGENTS.md` or `CLAUDE.md` |
| `*.stories.tsx` anywhere above, `apps/storybook/**` story wiring | |

At handoff only, the same writer may also edit existing product docs pages in
`apps/web/content/docs/`, as "Feature docs at handoff" below says; it never
creates one.

Backend, built by that same writer using canonical backend guidance, each under its owning
`AGENTS.md`:

- `apps/api/**`: thin route, fat service, `withAnyAuth`, Zod validation, org
  scoping on every query, the `Result` error model (`apps/api/AGENTS.md`).
- `packages/api/src/types/**`: shared request and response types, the one
  canonical place for them.
- `packages/database/**`: Prisma schema changes with a generated migration
  (`packages/database/AGENTS.md`); never edit a migration that has landed on
  main; never apply a migration to a shared database from this Mac (the API's
  Vercel build applies it to the session's own data on redeploy); every new
  model gets a seed coverage file and seed data in the vibe seed.
- `apps/desktop/src/main/**` and `apps/desktop/prisma/**`, when the change is a
  Desktop feature (`apps/desktop/AGENTS.md`; gateway operations stay in
  `apps/desktop/src/server/operations/`).
- One living session decision table stays local in
  `.closedloop-ai/decision-tables/<session-slug>.md` (gitignored in this repo).
  It is mandatory before code for every request, with stable row IDs, and
  verified afterward by the SAME writer under quality-loop.md; it is not
  backend-only. Handoff attaches it to the live ticket so the reviewing
  engineer sees whole-session behavior and actual coverage evidence.

The build loop stays lean (`quality-loop.md`, "Lean build loop"): quick
prep, the build, the quick checks the commit hooks need, the orchestrator's
commit, deploy, and showing the person. Reviews and heavy validation run only
at handoff: the guardrails and adversarial reviews, browser E2E, visual QA,
logical QA, Metal Andrew, the existing tests (the whole suite and two review
passes when backend code changed), the running web app and Desktop driven with
the repo's control skill, and the list of tests engineering still has to write
(Tests, below).

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

Vibe work is headed for `main`, so the closed-by-default UI policy applies: a
net-new screen, surface, or navigation item ships behind a default-off PostHog
flag (one key for web and Desktop, read where it gates). If the person chose
Labs, the Labs pattern is that flag. Tell them in one line that the new screen
stays hidden on their environment until that flag is turned on for them.

The prototype-first rule in the root `AGENTS.md` (net-new screens start in
`apps/prototypes`) does not apply to vibe sessions. That is an operator
decision recorded on ISS-12017. Build in Storybook and app code directly.

## Where code goes

- Generic, domain-free UI (a control, layout, token) belongs in
  `packages/design-system`. Domain UI (projects, sessions, branches,
  documents) belongs in its feature slice in `packages/app/<feature>/`
  (`components/`, `hooks/`, `lib/`). `apps/app` keeps route shells.
- Domain code never goes in `packages/design-system`; `biome.jsonc` blocks it.
- `packages/app` never imports `next/*`, `@clerk/*`, `@repo/database`,
  `@repo/analytics`, or an app alias; use the injected ports (see
  `packages/app/AGENTS.md`).
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
paths in `packages/app/AGENTS.md`: list surfaces use `GridTableV2` with the v2
pagination and header, dates format through `shared/lib/date-utils.ts`, and so
on. Read `.claude/design/discipline-core.md` once per session; it is the
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
4. Run `pnpm --filter storybook test` and confirm the new stories pass.
5. A new component is built with its stories before the feature that uses it.
   The orchestrator points the person to its stories on local Storybook in one
   plain message and does not wait (`SKILL.md`, section 5, "Notices that never
   wait"); the person may interrupt to change it.
6. Use it in the screen without waiting for a reply.

## Tokens and styling

No hardcoded colors, arbitrary pixel values, or ad-hoc dark-mode overrides.
Annotation "Adjust" values arrive as raw CSS (a hex color, a pixel size); map
each one to the nearest existing token or spacing step internally. If no token
is close, raise it as a missing primitive.
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

One explicit, scoped exception, granted by Daniel Ochoa on 2026-10-13: at
handoff the same writer drafts edits to existing product docs pages for the
features the session changed, under "Feature docs at handoff" below. It covers
only those marked drafts, which design or engineering approves before merge.
It is not a general license: no product UI copy, no new page, and no words
anywhere else come from it. Every other rule in this section still applies.

## Feature docs at handoff

Handoff has the same writer update the product docs that already exist for
the features this session changed, on the session's branch, in its explicit
handoff continuation. Nothing here runs during building.

- Pages: only existing product docs pages under `apps/web/content/docs/`
  (`.mdx`) that describe a changed feature. Find them by searching that folder
  for the changed screens, routes, components, flags and FEATURE_MAP ids.
- Never edit the repo's internal engineering `docs/` folder (PRDs, runbooks,
  schema and design notes). Internal engineering docs belong to engineering's
  pull request (Daniel Ochoa's ruling, 2026-10-13).
- Never create a page, add one to navigation (`meta.json`), or edit a
  generated page such as `apps/web/content/docs/api-reference/`. When no
  existing page covers a changed feature, record that and create nothing.
- Edit only passages that describe behavior this session changed, so they
  match what was built and accepted. Prefer the person's words and existing
  labels, and never claim a stronger guarantee than the code makes
  (`apps/web/AGENTS.md`).
- Mark every edited passage as an agent draft for design or engineering to
  approve before merge: put
  `{/* Agent draft (<live ticket slug>): approve before merge */}` before it
  and `{/* End agent draft */}` after it. Whoever approves the draft removes
  the markers.
- Record each edited page and what changed in the session change log; the
  ticket's Handoff section lists them under Feature docs.
- Owned prototype sessions skip this: a mockup changes no shipped feature.

The handoff inventory accepts modified existing pages in that folder only in
the handoff phase, and reports a new or generated page, or any `docs/` edit,
as outside the allowed paths.

## Accessibility

Icon-only controls get accessible names, disclosures get `aria-expanded`, one
`<main>` per page, and state is never conveyed by color alone.

## Labs

Default: no flag. When the person asks for Labs, follow the existing Labs
destination pattern: the route checks the `labs-nav-section` container flag
plus its own PostHog key (see `apps/app/app/(authenticated)/[orgSlug]/help/page.tsx`
and `packages/app/shared/lib/feature-flags.ts`). One key gates web and Desktop.
Tell them the Labs entry shows on their environment only if those flags are
on for them, and record the key in the session summary so handoff can list
it.

## Tests

No worker authors a test in vibe or handoff: no new `*.test.*` or `*.spec.*`
file, nothing new under `__tests__/` or `e2e/`, no new case, assertion,
snapshot or fixture, and no deleted test of live behavior. This holds in the
build loop and at handoff alike (Daniel Ochoa's ruling, 2026-10-13). The edits
allowed are a repair and a retired-only deletion, below. Existing tests run
at handoff, and stories remain part of component work.

Never ask the person about tests or any other engineering choice. These rules
decide it, or it goes to engineering, never to the person.

### Repair, don't author

When the session's own change breaks an EXISTING test or test fixture (an
import, a renamed or retired symbol, setup, a type error), the SAME persistent
`vibe-change-worker` mechanically updates that existing file so the tree
compiles and the commit hooks pass, in the build loop or at handoff (Daniel
Ochoa's ruling, 2026-10-13, after the PRD-720 live test). A repair never
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
request itself retires, citing the ticket or PRD that retires that code
(Daniel Ochoa's ruling, 2026-10-13; the root `AGENTS.md`: "When the contract
under test is deliberately retired, deleting its test is the complete and
correct outcome"). A test that still covers any live behavior is only
repaired, never deleted; when one file mixes both, delete only the retired
cases and repair the rest. Record every deletion before the commit with
`node <plugin-root>/skills/vibe/scripts/retired-tests.mjs record --worktree "<wt>" --path <test file> [--case "<test name>"] --retired-by <ISS-, PRD- or FEA- slug> --covers "<retired code it covered>"`.
The handoff inventory admits a deleted test file outside a pull request only
with that whole-file record and lists every recorded deletion under
`retiredTests`; `vibe-guardrails-reviewer` verifies each one covered only
retired code, and the live ticket lists them on its Retired tests deleted line
next to Missing tests so engineering sees them.

### Running and missing tests

Handoff runs the existing affected tests. When one fails, the SAME persistent
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

Never make a failing check pass by changing the check: test assertions and
expected values, snapshots, tolerances, skips, timeouts, coverage or size
thresholds, lint and type suppressions (`biome-ignore`, `@ts-expect-error`, a
cast that only quiets the compiler), a raised allowlist count, or the harness.
Fix the code. The shrink-only allowlist edit above, a test repair that leaves
every assertion unchanged, a recorded retired-only test deletion and the repo's explicitly human-directed
behavior-change rule in Tests are not ways to hide a failure.
If an expectation looks wrong without that evidence, keep it and report it.

## Repo rules that bite most often

From the root `AGENTS.md`; the Biome and source gates enforce most of them:
const objects instead of TypeScript `enum`, const references instead of
string literals, `<Link>` from `@repo/navigation/link` for in-app navigation,
`next/image` in `apps/app`, no `console` logging in client code, no nested
ternaries, cognitive complexity at most 20, files under 1,000 lines, regex
literals at module level, camelCase identifiers, imports at the top, new
functions at the bottom of a file, and no comments that narrate the code.
After each batch of edits run `pnpm exec biome check --write <changed files>`.
