# Provider text for README.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: intro -->
vibe lets a person change the ClosedLoop product (symphony-alpha) by saying
what they want in plain words. They work from the in-app browser in Codex
Desktop, or from Claude Code, and nobody in a session has to touch git, a
terminal command or the backend. Each change is built for them and deployed to
their own copy of the app on Vercel, which they sign in to as themselves. They
look at the real product with their change in it, ask for more, and when they
are done vibe either opens a pull request they take through review and merge,
or passes the work to the next owner, usually design and then engineering.
<!-- end: intro -->

<!-- block: audience -->
  where the screen has both), and can run a visual QA pass when the change is ready to polish.
<!-- end: audience -->

<!-- block: record -->
Everything a session does is recorded on a live ClosedLoop ticket, so whoever
picks the work up next sees what was asked for, what was built and what is
still open.
<!-- end: record -->

<!-- block: session-steps -->
   and names a ClosedLoop ticket or describes the change. vibe checks its own
   version, shows a short setup check (the installed closedloop-core and vibe
   versions for each harness, and whether the ClosedLoop and closedloop-graph
   connections answer), installs anything missing on the machine, creates the
   live ticket assigned to them, and opens their copy of the app. A lost
   connection or a GitHub sign-in is restored by the setup worker: the person
   only signs in in the browser, clicks Allow once when Codex asks to run a
   setup command, and starts a new chat only when the connection still fails
   in the current one. It starts with an example
   company that already has people and work in it, or empty when the request
   is about what a new account looks like. Desktop opens as a second tab when
   it is available.
<!-- end: session-steps -->

<!-- block: session-steps-2 -->
3. **See it live.** Each finished change deploys to their copy of the app
   without being asked. vibe says when it is ready to look at, and names any
   acceptance criterion that is not done yet instead of claiming it.
<!-- end: session-steps-2 -->

<!-- block: session-steps-3 -->
   them, with full tests written first. Otherwise vibe passes the ticket to
   the person they name. The ticket stays In Progress either way.
<!-- end: session-steps-3 -->

<!-- block: example-setup -->
vibe:  Sets up, creates the ticket and opens your copy of the app.
<!-- end: example-setup -->

<!-- block: mockup -->
workflow instead and returns a shareable Vercel preview link.
<!-- end: mockup -->

<!-- block: design-system -->
component catalog and the paved paths in `packages/app` before building
<!-- end: design-system -->

<!-- block: no-invented -->
order: the code and data model, the ticket and its PRD, the ClosedLoop graph
and live decisions, the product owner's direction, the approved prototype, and
then live Asana observed in the operator's signed-in browser. Public help
centers and documentation are never precedent. No agent adds a feature flag;
the person approves each key.
<!-- end: no-invented -->

<!-- block: criteria -->
ticket, its PRD and the person's own words, and records the result in the
<!-- end: criteria -->

<!-- block: complete-record -->
**A complete record.** The live ClosedLoop ticket links the document the
session started from, the session's implementation plan (published as a
linked PLN), the decision table, the environment and its production flag
snapshot, Design Review evidence (previews, Storybook changes, screenshots,
known gaps) and an Engineering checklist.
<!-- end: complete-record -->

<!-- block: real-review -->
review, the existing tests that cover each changed file, lint, source gates
and the affected typecheck, browser E2E, visual QA, logical QA and
product-contract QA. It also drives each touched screen in the running web app
and Desktop. Confirmed findings go back to the same writer. A check that also
fails on main is recorded for engineering instead of blamed on the session.
<!-- end: real-review -->

<!-- block: storybook-placement -->
and story placement, following symphony-alpha's `apps/storybook/TAXONOMY.md`
and Storybook skill where they say how, and mirroring that precedent's
structure, never its root or version, where they do not. Stories cover the
components consumers render, not internal render pieces. The writer records
the placement in its local plan; a conflict goes on the live ticket by
audience, design conflicts under Design Review and everything else on the
Engineering checklist, never to the person.
<!-- end: storybook-placement -->

<!-- block: story-freeze -->
New stories go in the current roots (`Composites/`, `Surfaces/` and the other
plain levels) with one lifecycle tag. A v1.0 story file (under a
`<Level> v1.0/` root or tagged `deprecated`) is never edited beyond a
compile-only repair, so new states of its component go in a new entry in the
current root holding only them. New states of any other existing component go
in its existing story file under the same title and tag, since a retitle
breaks every link to its stories; handoff blocks any other edit of a v1.0
story file except a compile-only repair, and a retitle unless it is a sibling
replacement's entry. Story files under the `Start Here/` root are exempt from
the v1.0 freeze and the title, tag and retitle checks (design ruling,
2026-10-06). Handoff judges story files by the scheme of the session's base,
read from that base's `apps/storybook/story-group-order.ts`, so a session
still based before symphony-alpha #8867 keeps the `v1.0`/`v2.0` rules until it
syncs main, and a sync is never blamed for the renames it imported.
<!-- end: story-freeze -->

<!-- block: engineering-paths -->
The writer may edit all of `apps/storybook/**`, including its `.storybook/`
config, `TAXONOMY.md` and `apps/storybook/scripts/`. When a request needs a
change in a path vibe never edits, such as the repo-root `scripts/**`,
<!-- end: engineering-paths -->

<!-- block: engineering-paths-2 -->
builds the rest; handoff puts each one on the live ticket's Engineering
checklist.

Nothing agent-written goes into product docs. The writer edits nothing under
`apps/web/content/docs/` and lists, under the ticket's Feature docs, the
existing pages that describe a changed feature, for design or engineering to
update.
<!-- end: engineering-paths-2 -->

<!-- block: seed-refresh -->
### `vibe-seed-refresh`

Keeps the seeded example data behind every session in step with main. It
checks the seed against fresh main and the latest Vibe Seed Walk run. When it
finds drift, workers create a ticket, fix the seed in a fresh worktree, run
the full web and Desktop screen walk, open a pull request, follow it through
the merge queue and mark the ticket Done.
<!-- end: seed-refresh -->

<!-- block: ticket-skills -->
### ClosedLoop ticket skills

`cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`,
`cl-work-report`, `cl-sweep` and `cl-execute` cover policy-aware ticket
analysis, related-ticket discovery, safe one-level splits, private project
work reports, sweep coordination and end-to-end ticket execution. The sweep
scripts use the managed Codex App Server through bundled helpers. They rely on
the operator's normal ClosedLoop, GitHub, `workflow-memory` and
`closedloop-graph` configuration.
<!-- end: ticket-skills -->
