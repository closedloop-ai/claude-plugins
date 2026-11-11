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
It is built for executives, designers, product managers and engineers:

- **Executives and product managers** describe a change in plain words, or
  point at the screen and comment, and see it working in the real product a
  few minutes later.
- **Designers** work from a reference screenshot or iterate on the look of a
  screen. vibe maps what the reference shows onto the design system's tokens
  and components, compares each touched screen with it (in light and dark
  where the screen has both), and can run a visual QA pass when the change is ready to polish.
- **Engineers** build fast with the same guardrails, Storybook rules and
  handoff review as everyone else, and take the pull request through review
  and merge themselves.
<!-- end: audience -->

<!-- block: record -->
Everything a session does is recorded on a live ClosedLoop ticket, so whoever
picks the work up next sees what was asked for, what was built and what is
still open.
<!-- end: record -->

<!-- block: session-steps -->
1. **Start.** The person types `$vibe` in Codex (`/vibe:vibe` in Claude Code)
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
2. **Ask for changes.** They click Annotate in the browser toolbar (or press
   Cmd + .), point at what they want changed and type a comment, or they just
   describe it in chat. A designer can attach a reference screenshot,
   including one of another product, or ask for changes to the look; anyone
   can name a product to work like.
3. **See it live.** Each finished change deploys to their copy of the app
   without being asked. vibe says when it is ready to look at, and names any
   acceptance criterion that is not done yet instead of claiming it.
4. **Answer only what only they can answer.** Product questions are researched
   first. A question reaches the person only when nothing else settles it, one
   at a time, and never twice.
5. **Finish.** They say they are done. Whoever will take it through review
   and merge themselves, often an engineer, gets a pull request opened for
   them, with full tests written first. Otherwise vibe passes the ticket to
   the person they name. The ticket stays In Progress either way.
<!-- end: session-steps -->

<!-- block: example-setup -->
vibe:  Sets up, creates the ticket and opens your copy of the app.
<!-- end: example-setup -->

<!-- block: mockup -->
A request for a mockup with made-up data runs the repository's prototype
workflow instead and returns a shareable Vercel preview link.
<!-- end: mockup -->

<!-- block: design-system -->
**Built from the design system, frontend and backend.** The writer reuses the
component catalog and the paved paths in `packages/app` before building
anything new, uses design tokens instead of hardcoded colors or pixel values,
and builds accessible controls. When a screen needs data or an action the API
does not provide, the same writer builds that backend too.
<!-- end: design-system -->

<!-- block: no-invented -->
**No invented product decisions or words.** User-visible words come from the
person, or from strings the product already renders; agents never compose
labels, empty states or error text. Product questions follow one research
order: the code and data model, the ticket and its PRD, the ClosedLoop graph
and live decisions, the product owner's direction, the approved prototype, and
then live Asana observed in the operator's signed-in browser. Public help
centers and documentation are never precedent. No agent adds a feature flag;
the person approves each key.
<!-- end: no-invented -->

<!-- block: criteria -->
**Acceptance criteria are checked before "ready".** Before a change is called
ready, the writer checks every acceptance criterion it touches, from the
ticket, its PRD and the person's own words, and records the result in the
session's decision table. When the person gave a reference image, the writer
reads it itself, turns what it shows into criteria mapped to tokens and
components, and compares a screenshot of each touched screen with it, in light
and in dark wherever the screen supports both, before saying it is ready.
<!-- end: criteria -->

<!-- block: complete-record -->
**A complete record.** The live ClosedLoop ticket links the document the
session started from, the session's implementation plan (published as a
linked PLN), the decision table, the environment and its production flag
snapshot, Design Review evidence (previews, Storybook changes, screenshots,
known gaps) and an Engineering checklist.
<!-- end: complete-record -->

<!-- block: real-review -->
**A real review at handoff.** The build loop stays fast; the heavy checks run
once, at the end. Handoff runs a guardrails review and a separate adversarial
review, the existing tests that cover each changed file, lint, source gates
and the affected typecheck, browser E2E, visual QA, logical QA and
product-contract QA. It also drives each touched screen in the running web app
and Desktop. Confirmed findings go back to the same writer. A check that also
fails on main is recorded for engineering instead of blamed on the session.
<!-- end: real-review -->

<!-- block: storybook-placement -->
Before the writer creates, retitles or moves a story or adds a shared
component, the read-only `vibe-storybook-decomposer` places it: it finds where
the same capability already exists for sibling entities and returns the owner
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
`.github/**` or an `AGENTS.md`, the writer leaves it alone, builds no
substitute elsewhere, logs it as `Engineering needed (forbidden path)` and
builds the rest; handoff puts each one on the live ticket's Engineering
checklist.

Nothing agent-written goes into product docs. The writer edits nothing under
`apps/web/content/docs/` and lists, under the ticket's Feature docs, the
existing pages that describe a changed feature, for design or engineering to
update.
<!-- end: engineering-paths -->

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
