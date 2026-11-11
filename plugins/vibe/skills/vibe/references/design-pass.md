# Design pass

Lines that start `> Provider` follow `references/provider-text.md`.

Vibe keeps the lean build loop internal, with independent reviews at handoff.
Existing tests run at handoff; no tests are authored in vibe or handoff unless
the person asks for a pull request, and the writer only repairs existing tests
its change broke. Nothing here is shown to or asked of the person.

## Owner rules

For any component that composes or inherits from a shared parent, shared
behavior goes in the parent and a child keeps only what is specific to that
child. The first fitting rule decides without asking the person.
Nobody asks the person where code goes.

<!-- generic: owner-slot -->
1. Behavior that the children of a shared parent share goes into that parent
   as a generic, domain-free slot or extension point, and each child opts in
   (one prop or one hook call) instead of reimplementing it. When the parent
   is in the shared design-system package, the slot is typed without domain
   nouns, because design-system code cannot import domain packages. The domain
   wiring (data hooks, API calls, nouns, labels) stays in the owning feature
   package, or its shared feature folder when more than one feature uses it,
   and is passed
   in. A slot alone is not an owner: the shared state and its handlers
   (selection, grouping, collapse, paging) live in the parent or in one
   shared hook the parent calls, and a child passes only its domain wiring.
   Two children that each keep their own copy of that state behind the
   parent's slot is the red flag the root `AGENTS.md` names under shared
   behavior in the shared parent, even when the slot exists.
<!-- end generic: owner-slot -->
> Provider `recipes` (block `owner-slot` of `vibe/design-pass.md`)
2. A child asking for what this session already built into a sibling (another
   child of the same parent) is rule 1: move it into the parent and have both
   opt in, never copy it.
3. Something a shared component already renders is extended there (a new
   prop or variant beside the existing default), never copied.
<!-- generic: owner-surface -->
4. Behavior specific to one child stays in that child, in its feature package
   in its feature package (route shells stay thin), on the surface that already
   owns the entity (`guardrails.md`, "Where code goes").
<!-- end generic: owner-surface -->
> Provider `recipes` (block `owner-surface` of `vibe/design-pass.md`)

An opt-in slot changes nothing for children that do not pass it; only altering
what they show raises the "everywhere or just here" question.

## Prep (build loop, one or two minutes)

The change worker does this lookup before editing. It is not a design session:
no second design, no questions, no approval.

<!-- generic: prep-screens -->
1. Screens and gates: each screen the request touches, its route, and the
   flag gates on it, found in the source (`rg` for the route and the gate). A
   screen a shared package renders has a host in each app that mounts it.
<!-- end generic: prep-screens -->
> Provider `recipes` (block `prep-screens` of `vibe/design-pass.md`)
<!-- generic: prep-parent -->
2. The shared parent and its other children: the definition, importers and
   callers (`repository-intelligence.md`) of each component you will touch,
   what it composes or inherits from, and what else builds on that parent.
   Include this session's earlier work, from the change log and the worktree.
<!-- end generic: prep-parent -->
> Provider `graph` (block `prep-parent` of `vibe/design-pass.md`)
<!-- generic: prep-components -->
3. Existing components: the repository's component catalog, its feature
   packages and shared helpers, for anything that already renders the
   concept, plus the paved paths and shared-surface rules in the nearest
   `AGENTS.md` of each directory involved.
<!-- end generic: prep-components -->
> Provider `recipes` (block `prep-components` of `vibe/design-pass.md`)
> Provider `memory` (block `prep-memory` of `vibe/design-pass.md`)
<!-- generic: prep-precedent -->
5. Precedent: where the same capability already exists for a sibling
   entity (another entity's list or detail surface): the component that
   provides it, how its hosts consume it, and where its stories live
   (`rg` on the capability's names and on imports of that
   component). Where the owner rules, the repo's `AGENTS.md` ("Shared behavior
   belongs in the shared parent") and its docs already say how, follow them;
   where they do not, mirror the precedent's ownership, component and
   Storybook structure, never its root or version.
<!-- end generic: prep-precedent -->
> Provider `graph` (block `prep-precedent` of `vibe/design-pass.md`)
6. Placement: before a story is created, retitled or moved or a shared
   component is added, the writer returns `NEEDS_STORYBOOK` and
   `vibe-storybook-decomposer` answers with its Placement block (`SKILL.md`,
   section 5). New states of an existing component go in a new entry in the
   current root holding only them when its story file is v1.0 (under a
   `<Level> v1.0/` root or tagged `deprecated`), which is never edited
   beyond a compile-only repair, and
   otherwise in its existing story file, title and tag unchanged; only a new
   component or a sibling replacement otherwise gets a new entry.
7. The owner, by the rules above and the precedent.

A copy, color, or spacing edit on one element reports `Prep: trivial` and
skips the rest of this bounded lookup, but does not waive the session decision table
before code. That real artifact still records the sourced change/preservation
rows and their stable row IDs under quality-loop.md. Otherwise the plan carries these blocks, and every unit
dispatch gets them verbatim:

```
Prep:
<!-- generic: plan-screens -->
- Screens: <each screen and host, with its route>
- Gates: <flag gates on those screens, or none>
<!-- end generic: plan-screens -->
> Provider `recipes` (block `plan-screens` of `vibe/design-pass.md`)
- Shared parent: <path and component, or none>
- Shared capability: <sourced behavior or none>
- Owner: <one parent path and component>
- Consumers: <every inheriting adapter>
- Prototype routes: <each consumer -> approved route/component, or none>
<!-- generic: plan-components -->
- Existing components: <catalog or feature package components and helpers to reuse, or none>
<!-- end generic: plan-components -->
> Provider `recipes` (block `plan-components` of `vibe/design-pass.md`)
- Earlier work: <what this session already built for it, or none>
- Memory: <pitfalls found, none found, or not installed>
- Precedent: <the sibling entity, providing component and how hosts consume it, or none found>
- Placement: <the decomposer's Owner, Stories, Fixtures, Names and Conflict lines, or no story or shared component>
- Rule: <the owner rule number that decided it, or `precedent`>
Graph:
- <one line per required call and what it established>
```

The SAME persistent writer builds at that owner and names `Owner: <path>`
with its Graph block. Units are tasks in its local plan, not separate writers.

## Quality depth at handoff

At handoff, never during the build loop, `vibe-guardrails-reviewer` screens the
session's diff and its session decision table, and the SAME persistent change
worker fixes what it confirms in fix mode, without asking the person.

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
  already exists, including a private local version of what a shared owner
  now provides (a local partition or group builder, a duplicated icon map, a
  helper the shared module exports, wording a shared helper renders).
- Hard-coded host keys: a URL search-param key, storage key or route segment
  spelled as a literal in a host adapter or child when a shared constant
  exists, or spelled separately on web and Desktop.
- Leftovers: what an extraction, move or deletion leaves behind: a pass-through
  file or wrapper that only forwards to the new owner, a re-export alias, an
  orphaned helper, type or constant, an unused prop, a loop or `each` table
  over the one arm left after a matrix arm was deleted, and a test still named
  or placed after a module that was deleted or moved.

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
<!-- generic: sibling-sweep -->
- Sibling sweep: after the fix, look for the same shape or defect at sibling
  sites (the other children of the owner through its importers and
  callers, and repeated strings or calls through `rg` in the worktree) and consolidate repeats in the
  session's own code. Do not opt in children the person did not name; list
  them.
<!-- end generic: sibling-sweep -->
> Provider `graph` (block `sibling-sweep` of `vibe/design-pass.md`)
- Tests and checks: no tests are authored; an existing test the restructure
  broke is repaired without changing what it asserts, handoff lists the
  missing ones for engineering (`guardrails.md`, "Tests"), and a failing check
  is never made to pass by changing it (`guardrails.md`, "Checks").

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
already disagree. Both run at handoff and report to the orchestrator, which
sends confirmed findings to the SAME writer; the person is not involved.
