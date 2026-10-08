# Design pass

Vibe requests arrive in the person's own words. The prep picks ownership by
rule; `quality-loop.md` then keeps the local technical plan, separate plan
review and implementation corrections internal and before handoff. Existing
tests may run during building, but test writing happens only at handoff.
Nothing here is shown to or asked of the person.

## Owner rules

The rule covers any component that composes or inherits from a shared parent
(a screen built on a shared surface, a variant of a shared control, a hook or
service built on a shared one): behavior the children share goes in the
parent, and a child keeps only what is specific to that child. Applied in
order; the first that fits decides. Nobody asks the person where code goes,
and nobody asks the person to confirm the approach. Independent technical
review follows `quality-loop.md` internally.

1. Behavior that the children of a shared parent share goes into that parent
   as a generic, domain-free slot or extension point, and each child opts in
   (one prop or one hook call) instead of reimplementing it. When the parent
   is in `packages/design-system`, the slot is typed without domain nouns,
   because design-system code cannot import `packages/app`, `@repo/api`, or
   `@repo/database`. The domain wiring (data hooks, API calls, nouns, labels)
   stays in the owning feature package in `packages/app`, or
   `packages/app/shared` when more than one feature uses it, and is passed
   in.
2. A child asking for what this session already built into a sibling (another
   child of the same parent) is rule 1: move it into the parent and have both
   opt in, never copy it.
3. Something a shared component already renders is extended there (a new
   prop or variant beside the existing default), never copied.
4. Behavior specific to one child stays in that child, in its feature package
   in `packages/app` (route shells stay thin), on the surface that already
   owns the entity (`guardrails.md`, "Where code goes").

An opt-in slot that other children do not pass changes nothing on them, so it
is not the "everywhere or just here" question; that question is only for a
change that alters what other children already show.

## Prep (build loop, one or two minutes)

The change worker's plan dispatch does this before any edit. It is a lookup,
not a design session: no second design, no questions, no approval.

1. Screens and gates: the FEATURE_MAP entry for each screen the request
   touches (`pnpm control feature show <id>`, or the entry in
   `.claude/skills/control/feature-map.json`) gives its web route, Desktop
   hash, flag gates, and code paths. A screen in `packages/app` has a web
   host (`apps/app`) and a Desktop host (`apps/desktop/src/renderer`).
2. The shared parent and its other children: the required closedloop-graph
   calls (`closedloop-graph.md`, Required calls) on each component you will
   touch, what it composes or inherits from, and what else builds on that
   parent.
   This session's earlier work is not in the graph, so read the change log
   and `rg` the worktree for it too.
3. Existing components: `packages/design-system/storybook/component-catalog.ts`,
   the `packages/app` feature packages, and `packages/app/shared` for
   anything that already renders the concept, plus the paved paths and
   shared-surface rules in `packages/app/AGENTS.md` and the nearest
   `AGENTS.md` of each directory involved.
4. Known pitfalls, when the `workflow-memory` command exists on this Mac:
   `workflow-memory query --summary-only --repo symphony-alpha --query "<screen and behavior keywords>"`
   (with `--env-file ~/.workflow/.env` when that file exists). One query;
   treat what it returns as hints to verify. Skip it when the command is not
   installed.
5. The owner, by the rules above.

A copy, color, or spacing edit on one element reports `Prep: trivial` and
skips the rest. Otherwise the plan carries these blocks, and every unit
dispatch gets them verbatim:

```
Prep:
- Screens: <each screen and host, with its FEATURE_MAP id>
- Gates: <flag gates the FEATURE_MAP lists for those screens, or none>
- Shared parent: <path and component the touched components compose or inherit from, or none>
- Existing components: <catalog or packages/app components and helpers to reuse, or none>
- Earlier work: <what this session already built for it, or none>
- Memory: <pitfalls found, none found, or not installed>
- Owner: <path where the behavior goes>
- Rule: <the owner rule number that decided it>
Graph:
- <one line per required call and what it established>
```

The change worker builds at that owner, and each unit's status names the
owner it built in (`Owner: <path>`) with its own Graph block.

## Quality depth before handoff

Before completing a feature `vibe-guardrails-reviewer` screens its diff, and the
change worker (the backend worker for backend code) fixes what it confirms in
fix mode, without asking the person.

### Red flags

- Shallow module: each caller coordinates several calls for one operation
  (every child wires the same hook, the same action list, and the same
  visibility rule to get one capability).
- Information leakage: one internal decision repeated across modules (the
  same rule written in two children of one parent).
- Temporal decomposition: modules split by when they run (fetch, then
  transform, then render, each in its own file) instead of by what they know.
- Pass-through: a layer that forwards props or calls unchanged and adds
  nothing.
- Copy: a near line-for-line copy of a component, hook, or helper that
  already exists.

### Restructuring

A fix that moves behavior to its owner works through, in its own reasoning:

- Discover: every screen, host, parent, helper, and consumer involved,
  through the required graph calls, verified in the worktree. Before
  changing or removing a guard, fallback, limit, or flag, find why it exists
  (`git log -L` or `git blame` and the introducing pull request) and keep it
  unless the person asked to change it. Never cite code as evidence of its
  own intent.
- Owner: by the owner rules above.
- Shape: when the change adds state, branches on a mode or kind, or repeats a
  shape across files, the structure that organizes it (a state machine over
  independent booleans, a table or registry over branching, one typed model
  over repeated shape checks) and the strongest alternative rejected, with a
  concrete reason from the code. For an established pattern, name the
  pattern and where it lives.
- Build the owner, then each child's opt-in. The design is wrong, not the
  code, when it needs the same workaround twice, an escape-hatch type (`as`,
  `any`, an optional field that is always set), or a child that must know
  the owner's internal rules to opt in; rethink the owner before going on.
- Stories at the owning level: the slot's stories live where the owner's
  stories are collected, and each child's story only shows it opted in.
- Sibling sweep: after the fix, look for the same shape or defect at sibling
  sites (the other children of the owner through `code_importers` and
  `code_callers`, repeated strings or calls through `code_grep`, then `rg` in
  the worktree for the session's own code) and consolidate repeats in the
  session's own code. Do not opt in children the person did not name; list
  them.
- Tests and checks: test writing waits for handoff (`guardrails.md`, "Tests"),
  and a failing check is never made to pass by changing it (`guardrails.md`,
  "Checks").

The fix status carries this block for each restructure, and handoff passes
it to the live ticket's Design decisions line:

```
Design:
- Owner: <path and the component, hook, module, or service the behavior now lives in>
- Shape: <the organizing structure, or the established pattern and where it lives>
- Rejected: <the strongest alternative> because <a concrete reason from the code>
- Red flags: <each one found and how the restructure removes it>
- Sweep: <sites checked, what was consolidated, children left alone>
```

## Review

`vibe-guardrails-reviewer` (check 8) reports, with `file:line` for every
site: each red flag; two children of one parent that each implement the
same behavior (blocking, naming the parent and the slot it belongs in); domain
code in a design-system slot; and code that is not in the `Owner` its change
log entry names. `vibe-adversarial-reviewer` checks whether repeated copies
already disagree. Both report to the orchestrator before handoff, which sends
confirmed findings to a fixing worker; the person is not involved.
