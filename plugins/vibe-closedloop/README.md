# vibe

Steps in this file written for symphony-alpha apply only in a repository that commits `.closedloop-ai/vibe-recipes.json`.

vibe lets a person change the ClosedLoop product (symphony-alpha) by saying
what they want in plain words. They work from the in-app browser in Codex
Desktop, or from Claude Code, and nobody in a session has to touch git, a
terminal command or the backend. Each change is built for them and deployed to
their own copy of the app on Vercel, which they sign in to as themselves. They
look at the real product with their change in it, ask for more, and when they
are done vibe either opens a pull request they take through review and merge,
or passes the work to the next owner, usually design and then engineering.

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

Everything a session does is recorded on a live ClosedLoop ticket, so whoever
picks the work up next sees what was asked for, what was built and what is
still open.

For an operator running several pull requests at once, `fleet-orchestrator`
runs Claude Code and Codex writers side by side and moves work between them
as either account's usage runs high. When a Codex writer dies, a Claude writer
takes over its worktree and carries on. It works on this machine and one more
machine over ssh: heavy checks take a capped number of slots on each machine
and go to the other machine when one is too loaded, and the shared e2e stack
runs one run at a time per machine under a lock.

## What a session looks like

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

A short example (the replies are paraphrased, apart from the endings line):

```text
You:   $vibe  Add a "Due this week" filter to the Projects board.
vibe:  Sets up, creates the ticket and opens your copy of the app.
       "When you're done, I can either open a pull request for you, or pass
       it to design or engineering to finish."
You:   (annotates the board header) Put it next to the search box.
vibe:  The Due this week filter is on the Projects board next to search.
       It's ready to look at.
You:   Looks good. Send it to design.
vibe:  "Who should I pass it to? A name or email is fine."
```

A request for a mockup with made-up data runs the repository's prototype
workflow instead and returns a shareable Vercel preview link.

## Why the result can be trusted

**One writer, one branch.** One persistent writer owns the session worktree and `vibe/<slug>` branch through handoff. Specialists advise; the orchestrator commits through repository hooks.

**Built from the design system, frontend and backend.** The writer reuses the
component catalog and the paved paths in `packages/app` before building
anything new, uses design tokens instead of hardcoded colors or pixel values,
and builds accessible controls. When a screen needs data or an action the API
does not provide, the same writer builds that backend too.

**No invented product decisions or words.** User-visible words come from the
person, or from strings the product already renders; agents never compose
labels, empty states or error text. Product questions follow one research
order: the code and data model, the ticket and its PRD, the ClosedLoop graph
and live decisions, the product owner's direction, the approved prototype, and
then live Asana observed in the operator's signed-in browser. Public help
centers and documentation are never precedent. No agent adds a feature flag;
the person approves each key.

**Acceptance criteria are checked before "ready".** Before a change is called
ready, the writer checks every acceptance criterion it touches, from the
ticket, its PRD and the person's own words, and records the result in the
session's decision table. When the person gave a reference image, the writer
reads it itself, turns what it shows into criteria mapped to tokens and
components, and compares a screenshot of each touched screen with it, in light
and in dark wherever the screen supports both, before saying it is ready.

**Tests.** The writer repairs broken tests without weakening assertions and lists missing coverage for engineering. Authoring requires a top-level grant. Handoff inventory admits authored tests only in the pull-request phase, which requires passing full tests.

**Paths.** Inventory reads the root `vibe-handoff-paths.json` from the captured base or verified default branch. Sessions cannot change this declaration or substitute a nested one. Repositories without it use their CI workflow and `AGENTS.md` test command with no protected path classes.

**A complete record.** The live ClosedLoop ticket links the document the
session started from, the session's implementation plan (published as a
linked PLN), the decision table, the environment and its production flag
snapshot, Design Review evidence (previews, Storybook changes, screenshots,
known gaps) and an Engineering checklist.

**A real review at handoff.** The build loop stays fast; the heavy checks run
once, at the end. Handoff runs a guardrails review and a separate adversarial
review, the existing tests that cover each changed file, lint, source gates
and the affected typecheck, browser E2E, visual QA, logical QA and
product-contract QA. It also drives each touched screen in the running web app
and Desktop. Confirmed findings go back to the same writer. A check that also
fails on main is recorded for engineering instead of blamed on the session.

**Humans merge.** On request, vibe opens the PR. The same writer fixes review findings, repeats checks and answers threads on that branch. The person handles queueing and merge.

### Storybook placement

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

### Paths vibe leaves to engineering

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

### `vibe-seed-refresh`

Keeps the seeded example data behind every session in step with main. It
checks the seed against fresh main and the latest Vibe Seed Walk run. When it
finds drift, workers create a ticket, fix the seed in a fresh worktree, run
the full web and Desktop screen walk, open a pull request, follow it through
the merge queue and mark the ticket Done.

### `fleet-orchestrator`

[Fleet orchestration](skills/fleet-orchestrator/SKILL.md) coordinates parallel PRs, one writer, or research without a writer. It covers ownership, durable state, usage-based routing, takeover, shared machines, E2E locks, QA and lessons. `fleet.sh` manages named local or SSH Codex threads in “Fleet workers” and archives completed threads.

### `codex-fleet-monitor`

[Fleet monitoring](skills/codex-fleet-monitor/SKILL.md) wakes on worker or PR changes, including silent stalls. It tracks usage, read failures and age by runtime and machine, flags readings older than 30 minutes, and wakes on material usage changes. `supervise.sh` handles transient provider errors with backoff on each host.

### Internal pipeline skills

`vibe-pipeline-backend`, `vibe-pipeline-docs-config`,
`vibe-pipeline-trivial-ui` and `vibe-pipeline-ui-feature` load the build and
handoff rules for the class selected by a session's triage manifest. They are
internal parts of `$vibe`, not separate entry points.

### ClosedLoop ticket skills

`cl-policy`, `cl-analyze`, `cl-find-related-tickets`, `cl-split`,
`cl-work-report`, `cl-sweep` and `cl-execute` cover policy-aware ticket
analysis, related-ticket discovery, safe one-level splits, private project
work reports, sweep coordination and end-to-end ticket execution. The sweep
scripts use the managed Codex App Server through bundled helpers. They rely on
the operator's normal ClosedLoop, GitHub, `workflow-memory` and
`closedloop-graph` configuration.

## Reference

### Installation

Codex installs both `vibe@closedloop-ai` and
`closedloop-core@closedloop-ai`. Claude Code installs
`vibe@closedloop-ai`; its dependency installs core automatically. The
[Mac installation guide](skills/vibe/INSTALL.md) sets up a vibe user's laptop;
the `vibe` skill installs everything else on its first run. No provider is
installed on its own; a release that has one carries it inside the plugin.

### Invocation names

Skills use `$<name>` in Codex and `/vibe:<name>` in Claude Code, so a
person types `$vibe` and `$handoff` (or `/vibe:vibe` and
`/vibe:handoff`). Codex workers read `agents/<name>.md` in this plugin;
Claude workers use `vibe:<name>`. Shared utilities belong to `closedloop-core` and are invoked by
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

Version `1.1.108` contains 17 skills and 17 agents, and no hook manifest: the
`vibe-core` plugin, which vibe declares as a dependency, registers the hooks and
runs `hooks/runtime.mjs` from the vibe a session uses. Skill commands forward to guards in `hooks/` and runtime modules in `lib/`. The package has no standalone commands, root shell scripts or production Python tools. Tests sit beside their owners; Python contract helpers and the generic scan live in `tools/python/`.

The [vibe skill](skills/vibe/SKILL.md) documents session records, triage (recommendations off by default), optional WS3 controls and WS8 load admission. [Handoff](skills/handoff/SKILL.md) documents publication checks. [Fleet orchestration](skills/fleet-orchestrator/SKILL.md) covers dispatch and cloud validation. Shared PR notifications and manual-QA browser helpers live in `closedloop-core`.
