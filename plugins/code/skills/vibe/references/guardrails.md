# Guardrails

Vibe work is handed to engineering, who finish the backend and run their own
reviews. It must already follow the team's patterns so they extend it rather
than rewrite it. The repo's `AGENTS.md` files are the contract; read the
nearest one before editing a directory. This file adds the rules specific to
vibe sessions and points at the repo rules that matter most here.

## What may change

| Allowed | Never |
|---|---|
| `apps/app/**` (web pages and route shells) | `apps/api/**`, `apps/mcp/**`, `apps/relay/**`, `apps/realtime/**` |
| `packages/app/**` (shared web and Desktop UI) | `packages/database/**`, any `prisma/` folder or migration |
| `packages/design-system/**` (primitives, tokens, stories) | `apps/desktop/src/main/**`, `apps/desktop/prisma/**` (Desktop backend) |
| `apps/desktop/src/renderer/**` (Desktop UI) | `packages/api/**` (shared API contracts belong to engineering) |
| `*.stories.tsx` anywhere above, `apps/storybook/**` story wiring | `packages/golden-sessions/**`, `.github/**`, `scripts/**`, any `AGENTS.md` |

That table is the **draft** scope. In draft scope, a request that can only be
met by a change in the right-hand column becomes a stub plus a written
requirement (`stubs.md`). Say so in one sentence and build the UI against the
stub.

### Full scope

In a **full** scope session (the session record's `scope`), the work goes all
the way, backend included. It still ends on the session's branch: design
reviews it, then an engineer opens the pull request and reviews it before it
merges. These move to allowed, each under its owning `AGENTS.md`, and are
built by `vibe-backend-worker`, never by the change worker:

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

Full-scope work is headed for `main`, so the closed-by-default UI policy
applies: a net-new screen, surface, or navigation item ships behind a
default-off PostHog flag (one key for web and Desktop, read where it gates).
If the person chose Labs, the Labs pattern is that flag. Tell them in one line
that the new screen stays hidden on their environment until that flag is
turned on for them.

Still never, in any scope: `packages/golden-sessions/**`, `.github/**`, and
`AGENTS.md` / `CLAUDE.md` files. Stubs are not used in full scope.

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

1. Stop and tell the person in one sentence: the screen needs a building block
   that does not exist yet, so you will add it to the component library first.
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
     `DS_*` set in `apps/storybook/scripts/taxonomy-classification.mjs`, and
     its tests go in `packages/design-system/__tests__/`.
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
each one to the nearest existing token or spacing step and tell the person
which token you used. If no token is close, raise it as a missing primitive.
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
state, tooltip, error, or helper text yourself; ask them for the words.

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

## Repo rules that bite most often

From the root `AGENTS.md`; the Biome and source gates enforce most of them:
const objects instead of TypeScript `enum`, const references instead of
string literals, `<Link>` from `@repo/navigation/link` for in-app navigation,
`next/image` in `apps/app`, no `console` logging in client code, no nested
ternaries, cognitive complexity at most 20, files under 1,000 lines, regex
literals at module level, camelCase identifiers, imports at the top, new
functions at the bottom of a file, and no comments that narrate the code.
After each batch of edits run `pnpm exec biome check --write <changed files>`.
