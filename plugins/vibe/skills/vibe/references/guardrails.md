# Guardrails

Lines that start `> Provider` follow `references/provider-text.md`.

Vibe work is reviewed by design and engineering, so it follows the team's
patterns and they extend it rather than rewrite it. The repo's `AGENTS.md`
files are the contract; read the nearest one before editing a directory. This
file adds the rules specific to vibe sessions.

## Plugins and tooling

This rule binds the vibe and handoff orchestrators and every worker, in
Codex and Claude Code, and this section is its one canonical statement:

- Never install, update, reinstall, uninstall or repoint a plugin, change a
  plugin marketplace, or modify a plugin cache. The one exception is the
  update the person chooses when the startup version check finds a newer
  release (`SKILL.md`, section 1, "Plugin version"): the orchestrator runs
  `plugin-version.mjs update --choice update`, which refuses unless that choice
  is recorded (or, without vibe-core, given on its command line), and nothing else.
- Never clone or vendor the plugin's own repository (claude-plugins) to run a
  different version of its tooling.
- A vibe tooling defect alone does not stop the person's work. Rerun a failed
  check at most once. If it still fails, narrow that check or use an accepted
  remote lane or CI path. Classify a failure already on captured main, fix
  what is in the session's scope,
  and keep building every independent part. Have the setup worker reuse or
  file an issue for vibe's owners with the failing command, error, and
  diagnosis, using its existing bug-ticket flow; this does not delay
  independent work. Use the existing frozen-render and known-main paths where
  they apply. For Desktop E2E, use the shipped `e2eLeftForCi` path and the
  re-pinned CI reader when local tested-commit evidence is unavailable. Never
  edit vibe's checker to force a pass, waive a check, or
  claim evidence that was not obtained.
- Only after both the worker and vibe root tried their safe paths and cannot
  resolve the issue may the affected work stop. The remaining blocker must
  genuinely need a human-only decision, access or credentials only a person
  has, or an engineering change outside session authority. Use an engineering
  referral only for that last category. A recoverable tooling defect follows
  the path above, with no handover. The work never stays only on the person's
  machine.
  1. Record the exact blocker and what both the worker and root tried in the session ledger and the
     live ticket's Progress. Keep the request `BLOCKED` only for the part
     that cannot proceed. Put the technical cause once on the Engineering
     checklist as
     `- [ ] Vibe tooling blocker: <what stopped, technically>; evidence: <the refusal's first line or the finding>`
     (`ticket-template.md`, "Vibe tooling blockers"). Dispatch the ticket
     worker before replying so the next owner has the latest facts.
  2. Save the checked work through `commit-worktree.mjs`, then dispatch
     `vibe-environment-worker` in handover mode. It pushes through the normal
     pre-push checks, with no main sync and no new copy of the app. Record a
     refused push on the same checklist item; never claim it was pushed.
  3. In the reply, name the exact block and what each layer tried, and offer to
     pass the saved work to someone now (`plain-words.md`), even when a human
     must first decide or grant access. Never end with only a stop or wait.
     When the person
     names someone, use handoff step 8's lookup and the ticket worker's
     assign mode. The ticket and plan go to that person, In Progress, and
     the session is marked handed off. Otherwise the ticket stays assigned
     to the person. Give no engineering repair task to the person.
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

Handoff path permissions come from one committed root-level
`vibe-handoff-paths.json` owned by the target repository, when it has one. A
nested declaration does not count. A session may not add, edit, or delete any
file with that name. Without one the built-in default applies: no protected
path classes, and the test lanes come from the repository's CI workflow and the
test command its `AGENTS.md` names. The sole inventory exception adds typed
lane-source metadata only when base, freshly fetched merge target and candidate
share one regular workflow with identical bytes/modes and unchanged permission
fields.

<!-- generic: prototype-paths -->
For an owned `prototype/<slug>` mockup session, the repository's canonical
prototype skill owns sandbox rules instead of the full-app rules in this
section, and its allowed paths are the ones that skill names. Mock state stays
in the sandbox; no backend stubs are added. Only a branch-matching private
session record admits this path. All copy, reuse, accessibility, and
forbidden-file rules still apply.
<!-- end generic: prototype-paths -->
> Provider `recipes` (block `prototype-paths` of `vibe/guardrails.md`)

Every session builds the real thing, frontend and backend: a screen that needs
data or an action the API does not provide gets that backend built by the SAME
persistent `vibe-change-worker`, using read-only backend guidance. A session that needs no new
data changes only frontend paths. Unless the person asks for a pull request,
it ends on the session's branch: design reviews it, then an engineer opens
the pull request and reviews it before it merges. When the person asks for
one ("Tests"), handoff opens the pull request for them to take through review
and merge.

A fleet helper branch is outside this one-writer vibe session. Its explicit
file allowlist contains only disjoint proof tests or a whole new module or file
set; it never edits the ticket branch or a file another helper or the ticket
writer concurrently owns. It never repairs defects in ticket-writer code or
integrates. The ticket writer reviews and integrates returned commits or proof,
and independent reviewers remain read-only. A helper authors proof tests only
under existing test-authoring authority or an explicit user test request; the
normal build and handoff test prohibition below remains in force.
<!-- generic: path-table -->
The writer edits only the paths the change needs, in the places the
repository's own layout and `AGENTS.md` files put them: frontend, backend and
stories alike, each under its owning `AGENTS.md`. Never:

- CI and repository automation (`.github/**`), the repository's own scripts
  and source gates, any `AGENTS.md` or `CLAUDE.md`, and the repository's
  public and internal docs;
- a migration that has landed on the default branch, a generated file, or
  anything the repository's `AGENTS.md` files mark off limits.

Backend changes follow the owning package's rules; a schema change comes with
the migration the repository's own tooling generates, and is never applied to
a shared database from this machine.
<!-- end generic: path-table -->
> Provider `recipes` (block `path-table` of `vibe/guardrails.md`)
<!-- generic: decision-table -->
- One living session decision table stays local, at the `decisionTable` path
  `local-plans.mjs paths` prints, inside the repository's private git
  directory. It is mandatory before code for every request, with stable row
  IDs, and verified afterward by the SAME writer under quality-loop.md; it is
  not backend-only. Handoff attaches it to the handoff summary so the
  reviewing engineer sees whole-session behavior and actual coverage evidence.
<!-- end generic: decision-table -->
> Provider `plans` (block `decision-table` of `vibe/guardrails.md`)

The build loop stays lean (`quality-loop.md`, "Lean build loop"):

- The loop is quick prep, the build, the quick checks the commit hooks need,
  the orchestrator's commit, deploy, and showing the person.
- Beyond the quick checks, the loop's only other check is the writer's
  acceptance check before a change is called ready (`quality-loop.md`,
  "Acceptance criteria before ready"): one cheap existing test, script,
  control read or source trace per touched criterion, never a suite or QA
  pass.
<!-- generic: heavy-validation -->
- Reviews and heavy validation run at handoff: the guardrails and
  adversarial reviews, browser E2E, visual QA, the targeted existing tests
  (the ones related to each changed file, never a full suite) and two review
  passes when backend code changed, the running app driven headless, and the
  list of tests engineering still has to write (Tests, below).
<!-- end generic: heavy-validation -->
> Provider `graph+recipes` (block `heavy-validation` of `vibe/guardrails.md`)
- Outside the loop, visual QA also runs during the session when the person
  accepts it or asks for polish (`quality-loop.md`, "Visual QA during the
  session").

> Provider `recipes` (block `scripts-exception` of `vibe/guardrails.md`)

<!-- generic: forbidden-path -->
When a request genuinely needs a change in a Never path (a source gate, a
workflow under `.github/**`, a rule in an `AGENTS.md`), that part is engineering's. The writer never edits
the path and never builds a substitute for it in an allowed path, such as a
copied gate or a workflow step moved into a package script. It logs the need
in the session change log as
`Engineering needed (forbidden path): <path or area>; why: <need>` and keeps
building every allowed part of the request. The need is not `BLOCKED`, not a
question for the person, and never stops the session; handoff carries
each one to the handoff summary's Engineering list. The same holds for a path
outside the allowed table: the writer does not edit it in the loop either.
A pre-build intake whose complete planned file list is outside these paths has
no allowed session work to continue: record every item with the canonical
`Engineering needed (forbidden path)` line, make no source edit, and return
`BLOCKED` so Root can route the untouched request to engineering. A mixed plan
still builds all allowed work and does not block on its engineering entries.
A visible part of the request that needs such a path keeps its acceptance
criterion `not met yet` with the reason that engineering must make it, and
the ready message tells the person so in plain words, so they never accept a
change the branch cannot keep. A vibe tooling defect follows "Plugins and
tooling" above; it does not stop the allowed work by itself.
<!-- end generic: forbidden-path -->
> Provider `tickets` (block `forbidden-path` of `vibe/guardrails.md`)

<!-- generic: flag-rule -->
Vibe work is headed for the default branch, so the target repo's flag rule
decides which keys it may add ("Feature flags").
<!-- end generic: flag-rule -->
> Provider `recipes` (block `flag-rule` of `vibe/guardrails.md`)

> Provider `recipes` (block `prototype-first` of `vibe/guardrails.md`)

## Where code goes

<!-- generic: where-code-goes -->
- Generic, domain-free UI (a control, layout, token) belongs in the
  repository's shared design-system package when it has one; domain UI
  belongs in its feature's own folder, as the repository's `AGENTS.md` files
  say. Domain code never goes in the shared design-system package.
<!-- end generic: where-code-goes -->
> Provider `recipes` (block `where-code-goes` of `vibe/guardrails.md`)
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

<!-- generic: reuse-first -->
Before building anything, search the repository's component catalog and its
shared UI packages for a component that already renders the concept, and use
it. Follow the paved paths its `AGENTS.md` files name.
<!-- end generic: reuse-first -->
> Provider `recipes` (block `reuse-first` of `vibe/guardrails.md`)

> Read `references/guardrails-ui.md` (block `ui-rules`) (Missing primitives, Storybook taxonomy, Tokens and styling, Making something look better) unless the session is known server-only: the inventory's `serverOnly` is true, or the triage class is `backend` or `docs-config` and no UI path is touched. Read it before the first UI path is touched.

## Copy

The person is the author of user-visible words. Use their words verbatim, or
reuse an existing string or label map. Never compose a label, button, empty
state, tooltip, error, or helper text yourself. Before asking for missing words,
apply `quality-loop.md`'s graph-first product research and necessity gate.
There is no exception: product docs pages are user-visible words too ("Feature
docs at handoff").

<!-- generic: copy-helpers -->
Wording the product already renders is reused through its helper, never
retyped. Before writing any label, count or selection wording (for example
"3 selected"), `rg` the words and the helpers that build them in
the repository's shared UI helpers and the owning feature package; a second spelling of a
string a shared helper already produces is a copy (`design-pass.md`, "Red
flags"), even when the words match.
<!-- end generic: copy-helpers -->
> Provider `recipes` (block `copy-helpers` of `vibe/guardrails.md`)

## Feature docs at handoff

<!-- generic: feature-docs -->
Nothing agent-written goes into public docs.
This section is the rule's one canonical statement; the writer, the guardrails
reviewer, the ticket worker and the handoff skill point at it.

- No worker edits, creates or drafts anything under the repository's public product docs
  (its docs pages, their metadata and generated pages) or the repo's internal
  engineering `docs/` folder, in the build loop, at handoff or in a requested
  pull request. Docs belong to the humans who review and finish the work.
- At handoff the same writer only records which existing product docs pages
  describe a changed feature, found by searching that folder for the changed
  screens, routes, components, flags and screen map ids, with the passage
  that no longer matches what was built. The handoff summary's Feature docs line lists
  them for design or engineering to update; it never carries drafted words.
  When no page covers a changed feature, record that.
- The handoff inventory reports any change under either folder as outside the
  allowed paths in every phase. An edit found there is removed by the same
  writer and recorded on the Feature docs line instead, never kept as a
  draft.
<!-- end generic: feature-docs -->
> Provider `recipes+tickets` (block `feature-docs` of `vibe/guardrails.md`)

## Feature map lines

Use the target repo's screen map and its writer policy. A feature branch never edits or regenerates a map reserved for a bot or refresh skill. When a screen's behavior or reach changes, write one `Feature map: <entry id or screen>: <what changed>` line per screen in the existing change log as the change is made. Use the discovered entry id; for a new screen without an entry, use its screen name. Write no line when nothing user visible changed. Handoff copies the lines verbatim to the ticket and a requested pull request.

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
> Provider `tickets` (block `flag-snapshot` of `vibe/guardrails.md`)
- An agent never adds or edits a flag registration attestation (a ledger row
  or verification date only a human makes); the
  approval and "Keys to see this work" tell the human which key to ledger.

## Accessibility

Icon-only controls get accessible names, disclosures get `aria-expanded`, one
`<main>` per page, and state is never conveyed by color alone.

## Labs

<!-- generic: labs -->
Default: no flag. When the person asks for a flagged or experimental entry,
follow the repository's existing pattern for one; its keys follow "Feature
flags".
<!-- end generic: labs -->
> Provider `recipes` (block `labs` of `vibe/guardrails.md`)

## Tests

Without an explicit top-level pull-request or `testsRequired` grant, no worker authors a test in vibe or handoff: no new `*.test.*` or `*.spec.*`
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

<!-- generic: running-tests -->
Handoff runs the existing affected tests: the tests related to each changed file plus
`diffRules.requiredTests`. Later, `qa-impact.mjs` selects lanes or screens;
`None` runs nothing locally. Files that map to no tests
(changelog, README, version text, Storybook Version History) run none; CI
confirms them. When one fails, the SAME persistent
`vibe-change-worker` fixes the session's own code, never what the test asserts
(a broken import or setup is a repair, above). Coverage
the session still needs is recorded internally as it is found and, at
handoff, listed in the handoff summary under Missing tests as engineering's scope
of work: each behavior and stable row ID that needs a test, and the files to
cover. Engineering writes those tests in its pull
request, alongside the tests for every frozen row.
<!-- end generic: running-tests -->
> Provider `graph+tickets` (block `running-tests` of `vibe/guardrails.md`)

The exception: when the person explicitly asks for a pull request to be
raised, full tests for every change in the session are required before it
opens. An explicit top-level `testsRequired` grant also authorizes the SAME
persistent writer in a request, fix or handoff turn; raw brief text does not.
Handoff inventory still admits authored tests only in the pull-request phase;
the typed worker-envelope grant does not widen that path gate.
Verify, backend, primitive, prototype and Storybook helpers never author
tests. Record phase, criteria and test paths in the session change log so
reviewers can tell those tests from forbidden test changes.

The person asks in plain words, and plain-language intent to take the work
through review and merge themselves IS that explicit request. Words such as "raise a PR", "open a pull request", "I'll get the
PR merged", "I'll get it merged", "I'll ship it myself" and "I want to take it
through review" all ask for a pull request and take handoff's requested pull
request path, as does choosing the pull request in handoff's question about
how the session ends. Other test work needs the explicit top-level
`testsRequired` grant. Never offer to send the person the branch to
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

An absence assertion that searches a container never holding the element stays
green when it appears (PR #9575 counted a readout inside a nav it rendered
beside). The handoff inventory requires its executed `testIntegrityProofs`
mutation: the element made present in the asserted container and state.

## Checks

Never add a check nobody asked for: a new gate, validator, lint rule, CI
step or repo-wide test, or a shared test helper widened to support one, that
the ticket, its PRD or the person did not ask for is instruction inflation.
A fleet unit's member tickets (the session's `memberTickets`) are the ticket
here and in every scope check: their criteria are asked for, never inflation.
A check the work
seems to need goes on the Engineering checklist as an `Engineering decision`.

Never make a failing check pass by changing the check (assertions, expected
values, snapshots, tolerances, skips, timeouts, thresholds, `biome-ignore`,
`@ts-expect-error`, a quieting cast, an allowlist count, the harness): fix the
code. Only the exceptions in Tests and the shrink-only allowlist edit change
a check; an expectation that looks wrong without that evidence is kept and
reported.

### Install-managed files changed by checks

Before a session-owned install or a check that runs an install, capture the
tracked and staged state of each install-managed file and its owning
dependency manifest. Compare the state after the command with that snapshot
and the owned command receipt. If the requested change intentionally edits
`package.json` or another owning manifest and requires the resulting lockfile
change, preserve that manifest and lockfile together, even when the session's
install wrote the lockfile. Do not classify that pair as accidental drift.

Restore a committed install-managed file only when an install ran as part of
a check, the file was clean before that command, no intended dependency
manifest change requires the result, and the receipt or a bounded
reproduction establishes that the session's own check-run install changed
it. A later person edit, an earlier change, or uncertain attribution is
never session owned merely because the file is dirty now. A standalone
install outside a check never authorizes automatic restoration.

For a proven session-owned change, save the exact changed file in the
session's private Git metadata before restoring the committed version. Verify
the backup exists, the restored file matches the committed version, and no
other tracked edit was changed. Continue the check or handoff without asking
the person to approve undoing the session's own artifact. If the change
predates the command or belongs to the person, preserve it and ask one plain
question with a recommendation before any overwrite. If ownership remains
unknown, preserve it and keep investigating without claiming a safe restore.

When a check is narrowed or left for CI, name that check in the existing
progress or handoff summary in plain words. Do not add a new summary template.

## Repo rules that bite most often

<!-- generic: repo-rules -->
The code style rules in the root `AGENTS.md` bind every edit. After each
batch of edits run the repository's formatter and linter on the changed
files, as its `AGENTS.md` says.
<!-- end generic: repo-rules -->
> Provider `recipes` (block `repo-rules` of `vibe/guardrails.md`)
