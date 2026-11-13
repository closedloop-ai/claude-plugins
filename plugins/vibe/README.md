# vibe

Lines that start `> Provider` follow `skills/vibe/references/provider-text.md`.

<!-- generic: intro -->
vibe lets a person change the product in any git repository by saying what
they want in plain words. They work from the in-app browser in Codex Desktop,
or from Claude Code, and nobody in a session has to touch git, a terminal
command or the backend. Each change is built for them and run the way the
repository documents running it, so they look at the product with their change
in it, ask for more, and when they are done vibe either opens a pull request
they take through review and merge, or passes the work to the next owner,
usually design and then engineering.

A provider plugin from vibe's marketplace can add one tracker's, organization's
or repository's knowledge to a session (its tickets, plans, code graph,
repository memory and repository recipes). vibe runs without one; with one
bound it also follows that provider's text and data.
<!-- end generic: intro -->
> Provider `tickets+recipes` (block `intro` of `readme.md`)

It is built for executives, designers, product managers and engineers:

- **Executives and product managers** describe a change in plain words, or
  point at the screen and comment, and see it working in the real product a
  few minutes later.
- **Designers** work from a reference screenshot or iterate on the look of a
  screen. vibe maps what the reference shows onto the design system's tokens
  and components, compares each touched screen with it (in light and dark
<!-- generic: audience -->
  where the screen has both), and runs the repository's own visual QA when it has one.
<!-- end generic: audience -->
> Provider `recipes` (block `audience` of `readme.md`)
- **Engineers** build fast with the same guardrails, Storybook rules and
  handoff review as everyone else, and take the pull request through review
  and merge themselves.

<!-- generic: record -->
Everything a session does is recorded in its local plan and decision table,
so whoever picks the work up next sees what was asked for, what was built and
what is still open.
<!-- end generic: record -->
> Provider `tickets` (block `record` of `readme.md`)

For an operator running several pull requests at once, `fleet-orchestrator`
runs Claude Code and Codex writers side by side and moves work between them
as either account's usage runs high. When a Codex writer dies, a Claude writer
takes over its worktree and carries on. It works on this machine and one more
machine over ssh: heavy checks take a capped number of slots on each machine
and go to the other machine when one is too loaded, and the shared e2e stack
runs one run at a time per machine under a lock.

## What a session looks like

1. **Start.** The person types `$vibe` in Codex (`/vibe:vibe` in Claude Code)
<!-- generic: session-steps -->
   in the repository's checkout and describes the change. vibe checks its own
   version, shows a short setup check (the installed vibe versions for each
   harness, and each provider connection when a provider is enabled), installs
   anything missing on the machine, bootstraps the worktree the way the
   repository documents, and starts the app when the repository documents how.
   A lost GitHub sign-in is restored by the setup worker: the person only
   signs in in the browser and clicks Allow once when Codex asks to run a
   setup command.
<!-- end generic: session-steps -->
> Provider `tickets+graph+recipes` (block `session-steps` of `readme.md`)
2. **Ask for changes.** They click Annotate in the browser toolbar (or press
   Cmd + .), point at what they want changed and type a comment, or they just
   describe it in chat. A designer can attach a reference screenshot,
   including one of another product, or ask for changes to the look; anyone
   can name a product to work like.
<!-- generic: session-steps-2 -->
3. **See it live.** Each finished change is running for them without being
   asked. vibe says when it is ready to look at, and names any acceptance
   criterion that is not done yet instead of claiming it.
<!-- end generic: session-steps-2 -->
> Provider `tickets+graph+recipes` (block `session-steps-2` of `readme.md`)
4. **Answer only what only they can answer.** Product questions are researched
   first. A question reaches the person only when nothing else settles it, one
   at a time, and never twice.
5. **Finish.** They say they are done. Whoever will take it through review
   and merge themselves, often an engineer, gets a pull request opened for
<!-- generic: session-steps-3 -->
   them, with full tests written first. Otherwise vibe passes the work to the
   person they name.
<!-- end generic: session-steps-3 -->
> Provider `tickets+graph+recipes` (block `session-steps-3` of `readme.md`)

A short example (the replies are paraphrased, apart from the endings line):

```text
You:   $vibe  Add a "Due this week" filter to the Projects board.
<!-- generic: example-setup -->
vibe:  Sets up and opens your copy of the app.
<!-- end generic: example-setup -->
> Provider `tickets+recipes` (block `example-setup` of `readme.md`)
       "When you're done, I can either open a pull request for you, or pass
       it to design or engineering to finish."
You:   (annotates the board header) Put it next to the search box.
vibe:  The Due this week filter is on the Projects board next to search.
       It's ready to look at.
You:   Looks good. Send it to design.
vibe:  "Who should I pass it to? A name or email is fine."
```

A request for a mockup with made-up data runs the repository's prototype
<!-- generic: mockup -->
workflow instead, when it has one.
<!-- end generic: mockup -->
> Provider `recipes` (block `mockup` of `readme.md`)

## Why the result can be trusted

**One writer, one branch.** A single implementation agent writes every change
in a session, in one worktree and one `vibe/<slug>` branch, keeping its context
from the first request to handoff. Specialists for backend, components,
Storybook and requirements advise it and never write code themselves. No agent
commits; the orchestrator commits through the repository's normal hooks.

**Built from the design system, frontend and backend.** The writer reuses the
<!-- generic: design-system -->
component catalog and the repository's paved paths before building
<!-- end generic: design-system -->
> Provider `recipes` (block `design-system` of `readme.md`)
anything new, uses design tokens instead of hardcoded colors or pixel values,
and builds accessible controls. When a screen needs data or an action the API
does not provide, the same writer builds that backend too.

**No invented product decisions or words.** User-visible words come from the
person, or from strings the product already renders; agents never compose
labels, empty states or error text. Product questions follow one research
<!-- generic: no-invented -->
order: the code and data model, the request and its sources, the repository's
recorded decisions, and then how an established product behaves, observed
live or from its own documentation. No agent adds a feature flag; the person
approves each key.
<!-- end generic: no-invented -->
> Provider `tickets+graph` (block `no-invented` of `readme.md`)

**Acceptance criteria are checked before "ready".** Before a change is called
ready, the writer checks every acceptance criterion it touches, from the
<!-- generic: criteria -->
request, its sources and the person's own words, and records the result in the
<!-- end generic: criteria -->
> Provider `tickets` (block `criteria` of `readme.md`)
session's decision table. When the person gave a reference image, the writer
reads it itself, turns what it shows into criteria mapped to tokens and
components, and compares a screenshot of each touched screen with it, in light
and in dark wherever the screen supports both, before saying it is ready.

**Tests are never weakened.** The writer repairs an existing test its change
broke without changing what the test asserts, and handoff lists missing tests
for engineering. The worker can write tests when its top-level turn explicitly
requires them. Handoff inventory admits newly authored tests only in the
pull-request phase, where full tests pass before the pull request opens.

**Paths come from the target repository.** A target can declare its handoff
paths in repo-root `vibe-handoff-paths.json`, as this plugin repository does.
Inventory reads the committed declaration from the target's captured base or
verified fetched default branch. A nested declaration does not count, and a
session diff cannot add, edit, or delete any file with that name. Without one,
handoff takes its test lanes from the repository's CI workflow and the test
command its `AGENTS.md` names, and protects no path classes.

<!-- generic: complete-record -->
**A complete record.** The session's local plan and decision table, kept in
the repository's private git directory, record what was asked for, what was
decided and what was built; handoff's summary carries them to the next owner
with the Storybook changes, screenshots and known gaps.
<!-- end generic: complete-record -->
> Provider `tickets+plans` (block `complete-record` of `readme.md`)

**A real review at handoff.** The build loop stays fast; the heavy checks run
once, at the end. Handoff runs a guardrails review and a separate adversarial
<!-- generic: real-review -->
review, the existing tests that cover each changed file, and the lint, type
check and other checks the repository documents. A review gate the repository
ships as its own skill runs when it is there and is recorded as unsupported,
never as a pass, when it is not. Confirmed findings go back to the same
writer. A check that also fails on main is recorded for engineering instead
of blamed on the session.
<!-- end generic: real-review -->
> Provider `recipes` (block `real-review` of `readme.md`)

**Humans merge.** vibe opens a pull request only when the person asks, and
never enqueues or merges it. When reviewers ask for changes, the session
resumes and the same writer fixes them, reruns the review and checks, pushes
to the same branch and answers each review thread.

### Storybook placement

Before the writer creates, retitles or moves a story or adds a shared
component, the read-only `vibe-storybook-decomposer` places it: it finds where
the same capability already exists for sibling entities and returns the owner
<!-- generic: storybook-placement -->
and story placement, following the repository's Storybook taxonomy document
where it has one, and mirroring that precedent's structure where it does not.
Stories cover the components consumers render, not internal render pieces.
The writer records the placement in its local plan, and handoff lists a
conflict for design or engineering, never for the person.
<!-- end generic: storybook-placement -->
> Provider `recipes` (block `storybook-placement` of `readme.md`)

<!-- generic: story-freeze -->
New states of an existing component go in its existing story file under the
same title, since a retitle breaks every link to its stories.
<!-- end generic: story-freeze -->
> Provider `recipes` (block `story-freeze` of `readme.md`)

### Paths vibe leaves to engineering

<!-- generic: engineering-paths -->
When a request needs a change in a path vibe never edits, such as
<!-- end generic: engineering-paths -->
> Provider `recipes` (block `engineering-paths` of `readme.md`)
`.github/**` or an `AGENTS.md`, the writer leaves it alone, builds no
substitute elsewhere, logs it as `Engineering needed (forbidden path)` and
<!-- generic: engineering-paths-2 -->
builds the rest; handoff lists each one for engineering.

Nothing agent-written goes into product docs. The writer edits no docs page
and lists the existing pages that describe a changed feature, for design or
engineering to update.
<!-- end generic: engineering-paths-2 -->
> Provider `recipes` (block `engineering-paths-2` of `readme.md`)

## The skills

### `vibe`

Starts or resumes a session, as described above. It also keeps usage in
check: each worker's model follows its role, and when a Codex or Claude usage
limit is reached the session pauses with one plain message saying so. Paid
credits are used only when the person says to use them.

### `handoff`

Finishes a session. It checks and reviews the work, verifies the final
environment or prototype preview, completes the live ticket, and ends the
session the way the person chose: a pull request they take through review and
merge, opened as handoff's last step with the ticket left with them, or
assigning the ticket to the next owner they name. Plain words such as "I'll
get the PR merged" or "I'll ship it myself" count as asking for a pull
request.

### `pr-takeover`

An engineer starts with a pull request URL in a new Claude Code or Codex chat.
The skill reviews the PR independently, checks each finding against its source,
routes verified bugs to one writer on the PR branch, and sends verified vibe
mistakes to a prevention ticket and worker. It runs the required web and
Desktop E2E lanes through supported headless or displayless paths, records
their actual results on the PR, answers review threads, and leaves the PR
open for the engineer to merge.

> Provider `recipes` (block `seed-refresh` of `readme.md`)

### `fleet-orchestrator`

A playbook for a Claude Code session running delivery work for an operator who
does QA and merges: several Codex and Claude workers on parallel pull
requests, one writer on one pull request, or a session with no writer
(design, research, analysis). It covers who may write where, state that
survives a reboot or compaction, Codex budget rules, a Claude takeover of a
stopped Codex writer, CPU and shared e2e stack locks across machines,
agent-first QA and a lessons ledger. Runtime and machine routing requires a
fresh usage reading, with stale readings re-read before work moves. `fleet.sh`
starts, steers, reads and ends
Codex threads on this machine or over ssh; each new thread is named for its
writer and grouped in the Codex app's "Fleet workers" sidebar section, and an
ended one is archived.

### `codex-fleet-monitor`

Watches a fleet of Codex threads and the pull requests they produce, and exits
on the first change: a session going idle, stalling or failing, a merge
conflict, new review comments, settled check changes or a new pull request. A
turn left open by a silent usage limit shows as `STALLED` instead of looking
busy forever. It persists each Codex and Claude usage read, including failed
reads, with its read time and source in bounded, atomically replaced state.
Its status command prints the latest reading and age per runtime and machine
and flags readings older than 30 minutes by default, while usage lines still
wake the watcher only on material changes such as a band change. It resumes a
turn that failed
on a transient provider error after a backoff, and `supervise.sh` runs that
recovery on each host with no orchestrator awake.

### Internal pipeline skills

`vibe-pipeline-backend`, `vibe-pipeline-docs-config`,
`vibe-pipeline-trivial-ui` and `vibe-pipeline-ui-feature` load the build and
handoff rules for the class selected by a session's triage manifest. They are
internal parts of `$vibe`, not separate entry points.

> Provider `tickets` (block `ticket-skills` of `readme.md`)

## Reference

### Installation

Codex installs both `vibe@closedloop-ai` and `closedloop-core@closedloop-ai`.
Claude Code installs `vibe@closedloop-ai`; its dependency installs core
automatically. The [Mac installation guide](skills/vibe/INSTALL.md) sets up a
vibe user's laptop; the `vibe` skill installs everything else on its first
run. A provider plugin is optional and installed on its own; vibe never
depends on one.

### Invocation names

Skills use `$<name>` in Codex and `/vibe:<name>` in Claude Code, so a person
types `$vibe` and `$handoff` (or `/vibe:vibe` and `/vibe:handoff`). Codex
workers read `agents/<name>.md` in this plugin; Claude workers use
`vibe:<name>`. Shared utilities belong to `closedloop-core` and are invoked by
name, not by reading another plugin's files: `$gh-monitor-pr`,
`$guided-manual-qa` or `$measurement-discipline` in Codex, and
`/closedloop-core:gh-monitor-pr`, `/closedloop-core:guided-manual-qa` or
`/closedloop-core:measurement-discipline` in Claude Code. The same pattern
applies to other shared skills such as `decision-table`.

### Agents

| Agent | Default model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only requirements, overlap and owning-route discovery; reference mode (the behaviors and visual and UX requirements of a product the person named or showed in a screenshot); precedent mode (how an established product behaves, observed live in the operator's signed-in browser or from that product's own documentation) |
| `vibe-ticket-worker` | sonnet | With a tracker provider bound: live ticket creation and source link, the session plan as a linked plan document, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, deployment records, and opening a pull request the person asked for at handoff |
| `vibe-change-worker` | opus | Sole persistent implementation writer for local planning, full-stack changes, stories, fixes, the handoff missing tests list and serialized recording |
| `vibe-backend-worker` | sonnet | Read-only decision-table and backend guidance for that writer |
| `vibe-primitive-worker` | sonnet | Read-only reusable-component and steward-specification guidance for that writer |
| `vibe-prototype-worker` | sonnet | Read-only canonical prototype guidance or operational immutable Vercel sharing of the writer's reviewed committed result |
| `vibe-storybook-decomposer` | sonnet | Read-only Storybook placement owner (precedent search on sibling entities before any story or shared component is placed) and component extraction, story and control guidance for that writer |
| `vibe-verify-worker` | sonnet | Read-only targeted existing checks (the tests related to each changed file), the e2e specs the change needs, handoff coverage review, Storybook footprint and handoff running app checks |
| `vibe-guardrails-reviewer` | sonnet | Read-only judgment-based review of reuse, placement (including Storybook precedent placement), copy provenance, accessibility, and tests |
| `vibe-adversarial-reviewer` | opus | Separate read-only handoff review of ownership, dependencies, contracts, regressions, and web/Desktop behavior |
| `vibe-consolidated-reviewer` | opus | Read-only single read of the final diff over the precomputed guardrails findings, used only when `review-scope.mjs` chooses the consolidated path (off unless `VIBE_CONSOLIDATED_REVIEW=1`) |
| `vibe-handoff-summarizer` | sonnet | Read-only plain-language summary of the session inventory, changes, and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | opus | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

Each model is a default. In Claude Code the `model:` line in each agent file
sets it; in Codex, `skills/vibe/scripts/worker-model.mjs` puts the read-only
explorers on `gpt-5.6-terra` and every other role on `gpt-6-sol`, at reasoning
effort `high`. To use another model on this machine, run
`node skills/vibe/scripts/worker-model.mjs set <claude|codex> <role or agent name> <model>`
(roles: writer, operational, reviewer, verifier, explorer); it is saved in
`~/.codex/vibe/models.json` and holds for every vibe session here. `unset`
removes it. Any model name is accepted.

### Evals

`evals/` holds 121 one-turn rehearsals plus two deterministic stateful
upgrade-resume cases. Each one-turn case carries the session state in its
prompt, so it needs no target repository checkout. The stateful cases run only in
the local nightly and drive real Claude and Codex root sessions across an
installed plugin upgrade. Claude tests the root's own resume or migration
decision. Codex tests its real install, cache and thread-resume boundaries plus
the released writer-state contracts with a harness-directed migration payload;
it does not test the Codex skill's independent migration decision. Cases are
named by persona: `exec-` for someone who describes the work and passes it on,
`pm-` for someone who iterates from reference
screenshots and may take it to a pull request themselves, and `orch-` for a
fleet orchestrator. Tags select a group, for example:

- how a session ends: `pr-intent`, `pass-on`, `unclear-end`, `pr-path`,
  `post-pr`, `pr-facts`;
- setup and questions: `setup`, `sample-data`, `questions`, `precedent`,
  `version-check`, `technical-detail`;
- visual work: `visual-cues` (reference screenshots, light and dark, tokens),
  `visual-qa`, `storybook`;
- handoff decisions: `main-failures`, `review-lessons`, `review-gates`,
  `qa-lessons`, `ticket-lessons`, `ledger-lessons`, `plan-links`;
- orchestration: `orchestrator`, `orchestration-lessons`, `fleet-single-use`,
  `pr-takeover`.

Run from the repository root. Each wrapper call requires a fresh empty output
directory and records both copied plugins before starting Claude:

```bash
eval_output=$(mktemp -d)
node plugins/vibe/skills/vibe/scripts/tested-head.mjs claude-eval "$PWD/plugins" "$eval_output" --model sonnet -j 2 --max-cost-usd 5 --no-publish
```

Add `--ablation none` to skip the no-plugin baseline arm. CI does not run it.

The `visual-cues` cases build in a small stand-in repository their scaffold
writes, with design tokens and a Pillow screenshot tool standing in for
Storybook, because the eval sandbox has no browser. Run them with the scaffold
and write tools:

```bash
eval_output=$(mktemp -d)
node plugins/vibe/skills/vibe/scripts/tested-head.mjs claude-eval "$PWD/plugins" "$eval_output" --tag visual-cues --scaffold --allow-tools Bash Write Edit --model opus --runs 3 -j 4 --no-publish --ablation none
```

Run the matching Codex suite from the repository root with
`uv run --with Pillow==12.3.0 python plugins/vibe/evals/codex/run.py`; see
[Codex evals](evals/codex/README.md) for caps, selection and results.

### Runtime files

Version `1.1.88` contains 17 skills and 17 agents, and no hook manifest: its
hooks, and every module they run, ship in the `vibe-core` plugin, which vibe
declares as a dependency. vibe loads those modules from vibe-core through
`shared/vibe-core.mjs`, and the commands among them keep thin wrappers at
their vibe paths. It has no standalone commands, root-level shell scripts,
or production Python tools under `tools/python/`; that directory contains the
skill-contract test modules, `vibe_contract_text.py` and `skill_split.py`, the text
helpers they share, and the `conftest.py` that applies the second. Runtime helpers and tests live alongside their owning skills, or under
`shared/` when reused across skills. They include vibe session and prototype records, the triage classifier and its manifest (recommendations off by default), local-plan publication guards, bundled
persistent writer state, Claude launch/resume and shared main-sync publication
helpers, handoff checks, sweep ownership and worker recovery, and the
work-report renderer, the WS3 control scripts (`setup-ctl`, `env-ctl`, `graph-pack`, `guardrails-gate`, `verify-run`, `req-gather`, `prototype-share`, `ticket-ctl` and the handoff inventory's `bundle`) that run a worker's mechanical steps with no model, each optional for the worker that uses it, and the WS8 load-aware execution scripts (`heavy-budget`, `load-admission`, `lane-pool`, `verify-background`) that make `run-bounded` and `verify-run` cooperate under load, the fleet dispatch scripts (`dispatch-route`, `dispatch-budget`, `cloud-placement`, `writer-placement`), the Vibe `cloud-worker` command, and `references/` files split out of the handoff, vibe, quality-loop, guardrails and fleet-orchestrator text that each skill reads only when its stated condition holds (`skill-split.mjs` reads a split file whole for tests). Shared PR-monitor notification delivery and manual-QA
browser helpers live in `closedloop-core`.
