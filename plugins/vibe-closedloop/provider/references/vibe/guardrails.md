# Provider text for skills/vibe/references/guardrails.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: prototype-paths -->
`<repo-root>/.claude/skills/prototype/SKILL.md` owns sandbox rules instead of
the full-app rules in this section. Its allowed host paths are exactly
`apps/prototypes/app/p/<slug>/`, the generated registry, and the exact portable
surface allowlist in `apps/prototypes/scripts/check-catalog-imports.mjs`.
The shared surface and stories still follow their owning package rules. Mock
state stays in the sandbox adapter; no backend stubs, seeded/blank environment,
or production flag snapshot is added. Only a branch-matching private session
record admits this path. All copy, reuse, accessibility, and forbidden-file
rules still apply.
<!-- end: prototype-paths -->

<!-- block: path-table -->

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
<!-- end: path-table -->

<!-- block: decision-table -->
- One living session decision table stays local in
  `.closedloop-ai/decision-tables/<session-slug>.md` (gitignored in this repo).
  It is mandatory before code for every request, with stable row IDs, and
  verified afterward by the SAME writer under quality-loop.md; it is not
  backend-only. Handoff attaches it to the live ticket so the reviewing
  engineer sees whole-session behavior and actual coverage evidence.
<!-- end: decision-table -->

<!-- block: heavy-validation -->
  adversarial reviews, browser E2E, visual QA, logical QA, product-contract
  QA, the targeted existing tests (the ones `code_tests_for` returns for each
  changed file, never a full suite) and two review passes when backend code
  changed, the running web app and Desktop driven with the repo's control
  skill, and the list of tests engineering still has to write (Tests, below).
<!-- end: heavy-validation -->

<!-- block: scripts-exception -->
One exception under `scripts/`: the shrink-only source-gate allowlist
(`scripts/lint/source-gate-allowlist.json`). When a gate reports a stale entry
for a file the session changed ("pins count 1, but only 0 remain"), delete
the entry or lower its count, and rerun the gate. Never add an entry or raise
a count. The handoff inventory checks the file only shrank.
<!-- end: scripts-exception -->

<!-- block: forbidden-path -->
When a request genuinely needs a change in a Never path beyond that one
exception (a source gate under `scripts/**`, a workflow under `.github/**`, a
rule in an `AGENTS.md`), that part is engineering's. The writer never edits
<!-- end: forbidden-path -->

<!-- block: forbidden-path-2 -->
question for the person, and never stops the session; the ticket worker
carries each one to the live ticket's Engineering checklist
(`ticket-template.md`, "Engineering needed"). The same holds for a path
<!-- end: forbidden-path-2 -->

<!-- block: flag-rule -->
Vibe work is headed for `main`, so the target repo's flag rule decides which
keys it may add ("Feature flags"). If the person chose Labs, the Labs pattern
is that flag. Tell them in one line that the new screen stays hidden on their
environment until that flag is turned on for them.
<!-- end: flag-rule -->

<!-- block: prototype-first -->
Vibe sessions skip the root `AGENTS.md` prototype-first rule and build in
Storybook and app code directly.
<!-- end: prototype-first -->

<!-- block: where-code-goes -->
- Generic, domain-free UI (a control, layout, token) belongs in
  `packages/design-system`. Domain UI (projects, sessions, branches,
  documents) belongs in its feature slice in `packages/app/<feature>/`
  (`components/`, `hooks/`, `lib/`). `apps/app` keeps route shells.
- Domain code never goes in `packages/design-system`; `biome.jsonc` blocks it.
<!-- end: where-code-goes -->

<!-- block: reuse-first -->
Before building anything, search
`packages/design-system/storybook/component-catalog.ts` and `packages/app` for
a component that already renders the concept, and use it. Follow the paved
paths in `packages/app/AGENTS.md`, such as the shared list surface with its
pagination and header, and the shared date formatting helpers. Read `.claude/design/discipline-core.md` once per session; it is the
team's design standard.
<!-- end: reuse-first -->

<!-- block: copy-helpers -->
`packages/app/shared` and the owning feature package; a second spelling of a
<!-- end: copy-helpers -->

<!-- block: feature-docs -->
- No worker edits, creates or drafts anything under `apps/web/content/docs/`
  (product docs pages, `meta.json`, generated pages) or the repo's internal
<!-- end: feature-docs -->

<!-- block: feature-docs-2 -->
  screens, routes, components, flags and FEATURE_MAP ids, with the passage
  that no longer matches what was built. The ticket's Feature docs line lists
<!-- end: feature-docs-2 -->

<!-- block: flag-snapshot -->
- The ticket's Production flag snapshot section shows "Keys to see this work"
  from the record, handoff tells the person, and `live-ticket-check.mjs`
  fails an unapproved key.
<!-- end: flag-snapshot -->

<!-- block: labs -->
Default: no flag. When the person asks for Labs, follow the repo's existing
Labs destination pattern: the route checks the repo's Labs container flag
plus its own PostHog key, as an existing Labs destination does. One key gates
web and Desktop.
Tell them the Labs entry shows on their environment only if those flags are
on for them; both keys follow "Feature flags".
<!-- end: labs -->

<!-- block: running-tests -->
Handoff runs the existing affected tests: the feature-complete `code_tests_for` tests plus
<!-- end: running-tests -->

<!-- block: running-tests-2 -->
handoff, listed on the live ticket under Missing tests as engineering's scope
of work: each behavior and stable row ID that needs a test, and the files to
cover (`ticket-template.md`). Engineering writes those tests in its pull
<!-- end: running-tests-2 -->

<!-- block: repo-rules -->
The code style rules in the root `AGENTS.md` bind every edit; the Biome and
source gates enforce most of them. After each batch of edits run
`pnpm exec biome check --write <changed files>`.
<!-- end: repo-rules -->
