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
- The backend worker's decision table stays local in
  `.closedloop-ai/decision-tables/` (gitignored in this repo); handoff attaches
  it to the live ticket so the reviewing engineer sees it.

Quality checks and implementation reviews run before handoff through
`quality-loop.md`. Handoff adds tests and final integrated verification,
with the whole test suite and two review passes when backend code changed.

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
  prep step, and what the quality reviewers check before handoff.

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
   plan. Do not narrate this technical dependency to the person.
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
     tests are written only at handoff (Tests, below).
   - Register it by running `pnpm --filter storybook catalog:sync` and
     `pnpm --filter storybook validate:catalog`. Never hand-edit
     `component-catalog.ts`.
4. Run `pnpm --filter storybook test` and confirm the new stories pass.
5. Open its story in the in-app browser (local Storybook, which the
   orchestrator starts for this) and ask the person to approve it there.
6. Only after approval, use it in the screen.

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

No build-loop worker writes or edits a test: no new or changed `*.test.*` or
`*.spec.*` file, nothing under `__tests__/` or `e2e/`, no snapshot or fixture
a test reads. Existing tests may run before handoff, and stories remain part
of component work. Required coverage is recorded internally in the local plan.

Test writing happens only at handoff through the SAME persistent
`vibe-change-worker` in handoff mode, for app and prototype sessions alike.
Verify/backend/primitive/prototype/Storybook helpers are not source or test authors.
Add or extend focused coverage of acceptance criteria, production wiring and
failure paths, then run and review it. Record phase, criteria and test paths
in the session change log so reviewers can distinguish handoff authoring from
forbidden early test changes.

Do not create source writers per unit, specialty or fix, or additional feature
worktrees/branches. Setup helpers never patch implementation code or add a new
local code workaround. The SAME persistent writer owns managed local
workarounds under their bug tickets, following `quality-loop.md`; existing
and new `localFixes` retain their exclusion and restore rules.

Preserve test integrity. A red test is a failing expectation: fix code when its
contract still stands. Changing an expectation requires the exact human
behavior ruling that made it obsolete, as the repo's Test Modification Guardrail
permits; record that ruling and retain coverage of every still-live contract.
Never loosen, skip or remove a valid test, edit a fixture or harness to mask a
failure, or raise timeouts/tolerances to get green. No PR is opened by either
vibe or handoff.

## Checks

Never make a failing check pass by changing the check: test assertions and
expected values, snapshots, tolerances, skips, timeouts, coverage or size
thresholds, lint and type suppressions (`biome-ignore`, `@ts-expect-error`, a
cast that only quiets the compiler), a raised allowlist count, or the harness.
Fix the code. The shrink-only allowlist edit above and the repo's explicitly
human-directed behavior-change rule in Tests are not ways to hide a failure.
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
