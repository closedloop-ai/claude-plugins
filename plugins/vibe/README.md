# vibe

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

**One writer, one branch.** A single implementation agent writes every change
in a session, in one worktree and one `vibe/<slug>` branch, keeping its context
from the first request to handoff. Specialists for backend, components,
Storybook and requirements advise it and never write code themselves. No agent
commits; the orchestrator commits through the repository's normal hooks.

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

**Tests are never weakened.** During a session no tests are written. The
writer repairs an existing test its change broke without changing what the
test asserts, and handoff lists the missing tests for engineering. Full tests
are written only when the person asks for a pull request, and they pass before
it opens.

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

**Humans merge.** vibe opens a pull request only when the person asks, and
never enqueues or merges it. When reviewers ask for changes, the session
resumes and the same writer fixes them, reruns the review and checks, pushes
to the same branch and answers each review thread.

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

Finishes a session. It checks and reviews the work, verifies the final
environment or prototype preview, completes the live ticket, and ends the
session the way the person chose: a pull request they take through review and
merge, opened as handoff's last step with the ticket left with them, or
assigning the ticket to the next owner they name. Plain words such as "I'll
get the PR merged" or "I'll ship it myself" count as asking for a pull
request.

### `vibe-seed-refresh`

Keeps the seeded example data behind every session in step with main. It
checks the seed against fresh main and the latest Vibe Seed Walk run. When it
finds drift, workers create a ticket, fix the seed in a fresh worktree, run
the full web and Desktop screen walk, open a pull request, follow it through
the merge queue and mark the ticket Done.

### `fleet-orchestrator`

A playbook for a Claude Code session running delivery work for an operator who
does QA and merges: several Codex and Claude workers on parallel pull
requests, one writer on one pull request, or a session with no writer
(design, research, analysis). It covers who may write where, state that
survives a reboot or compaction, Codex budget rules, a Claude takeover of a
stopped Codex writer, CPU and shared e2e stack locks across machines,
agent-first QA and a lessons ledger. `fleet.sh` starts, steers, reads and ends
Codex threads on this machine or over ssh; each new thread is named for its
writer and grouped in the Codex app's "Fleet workers" sidebar section, and an
ended one is archived.

### `codex-fleet-monitor`

Watches a fleet of Codex threads and the pull requests they produce, and exits
on the first change: a session going idle, stalling or failing, a merge
conflict, new review comments, settled check changes or a new pull request. A
turn left open by a silent usage limit shows as `STALLED` instead of looking
busy forever. It prints a usage line per machine, resumes a turn that failed
on a transient provider error after a backoff, and `supervise.sh` runs that
recovery on each host with no orchestrator awake.

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

Codex installs both `vibe@closedloop-ai` and `closedloop-core@closedloop-ai`.
Claude Code installs `vibe@closedloop-ai`; its dependency installs core
automatically. The [Mac installation guide](skills/vibe/INSTALL.md) sets up a
vibe user's laptop; the `vibe` skill installs everything else on its first
run.

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

| Agent | Model | Responsibility |
|---|---|---|
| `vibe-setup-worker` | sonnet | Machine preflight, worktree bootstrap, owned local processes, and confirmed session discard |
| `vibe-requirements-worker` | sonnet | Read-only ticket, requirements, overlap and owning-route discovery; reference mode (the behaviors and visual and UX requirements of a product the person named or showed in a screenshot); precedent mode (live Asana observed in the operator's signed-in browser, never public help centers) |
| `vibe-ticket-worker` | sonnet | Live ticket creation and source link, the session plan as a linked PLN, next-owner lookup, handoff grading, assignment, and cancellation |
| `vibe-environment-worker` | sonnet | Vercel environment creation, redeploy, flag snapshots, Desktop setup, deployment records, and opening a pull request the person asked for at handoff |
| `vibe-change-worker` | sonnet | Sole persistent implementation writer for local planning, full-stack changes, stories, fixes, the handoff missing tests list and serialized recording |
| `vibe-backend-worker` | sonnet | Read-only decision-table and backend guidance for that writer |
| `vibe-primitive-worker` | sonnet | Read-only reusable-component and steward-specification guidance for that writer |
| `vibe-prototype-worker` | sonnet | Read-only canonical prototype guidance or operational immutable Vercel sharing of the writer's reviewed committed result |
| `vibe-storybook-decomposer` | sonnet | Read-only Storybook placement owner (precedent search on sibling entities before any story or shared component is placed) and component extraction, story and control guidance for that writer |
| `vibe-verify-worker` | sonnet | Read-only targeted existing checks (`code_tests_for` per changed file), locked containerized e2e for the specs the change needs, handoff coverage review, Storybook footprint and handoff running app checks with `pnpm control` |
| `vibe-guardrails-reviewer` | sonnet | Read-only judgment-based review of reuse, placement (including Storybook precedent placement), copy provenance, accessibility, and tests |
| `vibe-adversarial-reviewer` | opus | Separate read-only handoff review of ownership, dependencies, contracts, regressions, and web/Desktop behavior |
| `vibe-handoff-summarizer` | sonnet | Read-only plain-language summary of the session inventory, changes, and overlaps |
| `vibe-seed-check-worker` | sonnet | Fresh-main seed checks and latest Vibe Seed Walk inspection |
| `vibe-seed-fix-worker` | sonnet | Seed drift fixes, validation, and follow-up PR-check and review-comment fixes |
| `vibe-seed-pr-worker` | sonnet | Seed PR push, status, main sync, merge queue, review replies, and owned worktree cleanup |

In Claude Code the `model:` line in each agent file sets its model. In Codex,
`skills/vibe/scripts/worker-model.mjs` puts the read-only explorers on
`gpt-5.6-terra` and every writer, reviewer and verifier on `gpt-6-sol`, at
reasoning effort `high`.

### Evals

`evals/` holds a `claude plugin eval` suite of 96 one-turn rehearsals. Each
case carries the session state in its prompt, so it needs no symphony-alpha
checkout. Cases are named by persona: `exec-` for someone who describes the
work and passes it on, `pm-` for someone who iterates from reference
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
- orchestration: `orchestrator`, `orchestration-lessons`, `fleet-single-use`.

The cases load `closedloop-core` too, which sits outside this plugin, so run
the suite from the repository's `plugins/` folder:

```bash
cd plugins
claude plugin eval . --eval-dir vibe/evals --model sonnet -j 2 --max-cost-usd 5 --no-publish
```

Add `--ablation none` to skip the no-plugin baseline arm. CI does not run it.

The `visual-cues` cases build in a small stand-in repository their scaffold
writes, with design tokens and a Pillow screenshot tool standing in for
Storybook, because the eval sandbox has no browser. Run them with the scaffold
and write tools:

```bash
cd plugins
claude plugin eval . --eval-dir vibe/evals --tag visual-cues --scaffold --allow-tools Bash Write Edit --model opus --runs 3 -j 4 --no-publish --ablation none
```

Run the matching Codex suite from the repository root with
`uv run --with Pillow==12.3.0 python plugins/vibe/evals/codex/run.py`; see
[Codex evals](evals/codex/README.md) for caps, selection and results.

### Runtime files

Version `1.1.12` contains 12 skills, 16 agents, and one hook manifest
(`hooks/hooks.json`). It has no standalone commands, root-level shell scripts,
or production Python tools under `tools/python/`; that directory contains the
skill-contract test modules and `vibe_contract_text.py`, the text helpers they
share. Runtime helpers and tests live alongside their owning skills, including
vibe session and prototype records, local-plan publication guards, bundled
persistent writer state, Claude launch/resume and shared main-sync publication
helpers, handoff checks, sweep ownership and worker recovery, and the
work-report renderer. Shared PR-monitor notification delivery and manual-QA
browser helpers live in `closedloop-core`.
