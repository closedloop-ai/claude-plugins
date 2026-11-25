# vibe

<!-- provider-rule -->
Lines that start `> Provider` stand for an optional provider's text. With no provider bound, follow the generic text.
<!-- end provider-rule -->

<!-- generic: intro -->
vibe lets a person change the product in any git repository by saying what
they want in plain words. They work from the in-app browser in Codex Desktop,
or from Claude Code, and nobody in a session has to touch git, a terminal
command or the backend. Each change is built for them and run the way the
repository documents running it, so they look at the product with their change
in it, ask for more, and when they are done vibe either opens a pull request
they take through review and merge, or passes the work to the next owner,
usually design and then engineering.

A provider can add one tracker's, organization's or repository's knowledge to
a session (its tickets, plans, code graph, repository memory and repository
recipes). A provider is never a plugin of its own: a build of vibe that has one
carries it inside. This plugin carries none, so its sessions follow the generic
text.
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

1. **Start.** The person types `$vibe` in Codex (`/vibe-generic:vibe` in Claude Code)
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

**One writer, one branch.** One persistent writer owns the session worktree and `vibe/<slug>` branch through handoff. Specialists advise; the orchestrator commits through repository hooks.

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
live in the operator's signed-in browser. Public help centers and
documentation are never precedent. No agent adds a feature flag; the person
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

**Tests.** The writer repairs broken tests without weakening assertions and lists missing coverage for engineering. Authoring requires a top-level grant. Handoff inventory admits authored tests only in the pull-request phase, which requires passing full tests.

**Paths.** Inventory reads the root `vibe-handoff-paths.json` from the captured base or verified default branch. Sessions cannot change this declaration or substitute a nested one. Repositories without it use their CI workflow and `AGENTS.md` test command with no protected path classes.

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

**Humans merge.** On request, vibe opens the PR. The same writer fixes review findings, repeats checks and answers threads on that branch. The person handles queueing and merge.

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

[Handoff](skills/handoff/SKILL.md) verifies the work and preview and updates the ticket. It opens a PR for someone taking the change through merge (including "I'll get the PR merged" or "I'll ship it myself"), or assigns the ticket to their chosen next owner.

### `pr-takeover`

[PR takeover](skills/pr-takeover/SKILL.md) starts from a PR URL in Claude Code or Codex. Independent findings go to one writer on the PR branch. It records prevention work, headless web and displayless Desktop E2E results and thread replies. The engineer merges.

> Provider `recipes` (block `seed-refresh` of `readme.md`)

### `fleet-orchestrator`

[Fleet orchestration](skills/fleet-orchestrator/SKILL.md) coordinates parallel PRs, one writer, or research without a writer. It covers ownership, durable state, usage-based routing, takeover, shared machines, E2E locks, QA and lessons. `fleet.sh` manages named local or SSH Codex threads in “Fleet workers” and archives completed threads.

### `codex-fleet-monitor`

[Fleet monitoring](skills/codex-fleet-monitor/SKILL.md) wakes on worker or PR changes, including silent stalls. It tracks usage, read failures and age by runtime and machine, flags readings older than 30 minutes, and wakes on material usage changes. `supervise.sh` handles transient provider errors with backoff on each host.

### Internal pipeline skills

`vibe-pipeline-backend`, `vibe-pipeline-docs-config`,
`vibe-pipeline-trivial-ui` and `vibe-pipeline-ui-feature` load the build and
handoff rules for the class selected by a session's triage manifest. They are
internal parts of `$vibe`, not separate entry points.

> Provider `tickets` (block `ticket-skills` of `readme.md`)

## Reference

### Installation

Codex installs both `vibe-generic@closedloop-ai` and
`closedloop-core@closedloop-ai`. Claude Code installs
`vibe-generic@closedloop-ai`; its dependency installs core automatically. The
[Mac installation guide](skills/vibe/INSTALL.md) sets up a vibe user's laptop;
the `vibe` skill installs everything else on its first run. No provider is
installed on its own; a release that has one carries it inside the plugin.

### Invocation names

Skills use `$<name>` in Codex and `/vibe-generic:<name>` in Claude Code, so a
person types `$vibe` and `$handoff` (or `/vibe-generic:vibe` and
`/vibe-generic:handoff`). Codex workers read `agents/<name>.md` in this plugin;
Claude workers use `vibe-generic:<name>`. Shared utilities belong to `closedloop-core` and are invoked by
name, not by reading another plugin's files: `$gh-monitor-pr`,
`$guided-manual-qa` or `$measurement-discipline` in Codex, and
`/closedloop-core:gh-monitor-pr`, `/closedloop-core:guided-manual-qa` or
`/closedloop-core:measurement-discipline` in Claude Code. The same pattern
applies to other shared skills such as `decision-table`.

### Agents

| Agent | Default model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ownership, overlaps, requirements, reference-product behavior and live precedent (signed-in browser, never public help centers or documentation) |
| `vibe-ticket-worker` | sonnet | Tracker tickets, source and plan links, handoff grading, assignment and cancellation |
| `vibe-environment-worker` | sonnet | Environment and prototype publication, flag snapshots, Desktop setup and requested PR creation |
| `vibe-change-worker` | opus | Persistent writer for planning, implementation, stories, fixes, missing-test lists and serial records |
| `vibe-backend-worker` | sonnet | Read-only backend and decision-table guidance |
| `vibe-primitive-worker` | sonnet | Read-only primitive and component specifications |
| `vibe-prototype-worker` | sonnet | Read-only prototype guidance and immutable publication of reviewed commits |
| `vibe-storybook-decomposer` | sonnet | Read-only Storybook placement, sibling precedents, extraction, stories and controls |
| `vibe-verify-worker` | sonnet | Read-only related tests, E2E selection, coverage, Storybook footprint and running app checks |
| `vibe-guardrails-reviewer` | sonnet | Read-only reuse, placement, copy, accessibility and test review |
| `vibe-adversarial-reviewer` | opus | Independent ownership, dependency, contract, regression and web/Desktop review |
| `vibe-consolidated-reviewer` | opus | Single read of final diff and guardrails findings when `review-scope.mjs` selects consolidation (`VIBE_CONSOLIDATED_REVIEW=1`) |
| `vibe-handoff-summarizer` | sonnet | Read-only summary of inventory, changes and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | opus | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

Each model is a default. In Claude Code the `model:` line in each agent file
sets it; in Codex, `skills/vibe/scripts/worker-model.mjs` puts the read-only
explorers on `gpt-5.6-terra` and every other role on `gpt-6.2-sol`, at reasoning
effort `high`; cl-execute and cl-sweep planning and review lanes take
`gpt-6.2-astra` when cl-analyze graded the ticket HIGH. A Codex whose own model
list lacks `gpt-6.2-sol` or `gpt-6.2-astra` runs `gpt-5.6-sol` instead. To use another model on this machine, run
`node skills/vibe/scripts/worker-model.mjs set <claude|codex> <role or agent name> <model>`
(roles: writer, operational, reviewer, verifier, explorer); it is saved in
`~/.codex/vibe/models.json` and holds for every vibe session here. `unset`
removes it. Any model name is accepted. cl-sweep ticket-owner sessions use the Codex writer model, including an override set this way.

### Evals

The [eval suite](evals/) includes 125 one-turn persona rehearsals and two stateful upgrade-resume cases. One-turn prompts supply their own session state. The local nightly exercises real Claude and Codex root sessions across an installed upgrade. Claude tests the root’s migration decision. Codex tests installation, caching, thread resume and released writer-state contracts using a harness-directed migration.

Select persona prefixes (`exec-`, `pm-`, `orch-`) or tags including `visual-cues`,
  `visual-qa`, `storybook`;
  `questions`, `pr-intent`, `review-gates`, `orchestration-lessons`.

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

Version `1.1.110` contains 17 skills and 17 agents, and no hook manifest: the
`vibe-core` plugin, which vibe declares as a dependency, registers the hooks and
runs `hooks/runtime.mjs` from the vibe a session uses. Skill commands forward to guards in `hooks/` and runtime modules in `lib/`. The package has no standalone commands, root shell scripts or production Python tools. Tests sit beside their owners; Python contract helpers and the generic scan live in `tools/python/`.

The [vibe skill](skills/vibe/SKILL.md) documents session records, triage (recommendations off by default), optional WS3 controls and WS8 load admission. [Handoff](skills/handoff/SKILL.md) documents publication checks. [Fleet orchestration](skills/fleet-orchestrator/SKILL.md) covers dispatch and cloud validation. Shared PR notifications and manual-QA browser helpers live in `closedloop-core`.
