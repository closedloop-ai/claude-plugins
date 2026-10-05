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

If a request can only be met by a change in the right-hand column, it becomes a
stub plus a written requirement (`stubs.md`). Say so in one sentence and build
the UI against the stub.

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
5. Open its story in the in-app browser (Storybook URL from the `VIBE_ENV`
   line) and ask the person to approve it there.
6. Only after approval, use it in the screen.

## Tokens and styling

No hardcoded colors, arbitrary pixel values, or ad-hoc dark-mode overrides.
Annotation "Adjust" values arrive as raw CSS (a hex color, a pixel size); map
each one to the nearest existing token or spacing step and tell the person
which token you used. If no token is close, raise it as a missing primitive.
No icon-in-a-colored-box chips, no borders on everything, no badge where a
plain string works.

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
Tell them the Labs entry shows on their preview link only if those flags are on
for their account, and record the key in the session summary so handoff can
list it.

## Repo rules that bite most often

From the root `AGENTS.md`; the Biome and source gates enforce most of them:
const objects instead of TypeScript `enum`, const references instead of
string literals, `<Link>` from `@repo/navigation/link` for in-app navigation,
`next/image` in `apps/app`, no `console` logging in client code, no nested
ternaries, cognitive complexity at most 20, files under 1,000 lines, regex
literals at module level, camelCase identifiers, imports at the top, new
functions at the bottom of a file, and no comments that narrate the code.
After each batch of edits run `pnpm exec biome check --write <changed files>`.
