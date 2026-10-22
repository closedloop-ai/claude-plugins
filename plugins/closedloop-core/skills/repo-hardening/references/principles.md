# The lens

Twenty-four principles, each with the rule, when it applies, and what evidence in a repository shows it is or is not followed. Use it for the audit (step 3) and name the principle when it changes a decision in direct work.

## Correctness and proof

**Prove it works.** Verify against the real artifact, not a proxy, a self-report, or "it compiles". Script the check when you can so a reviewer can rerun it. When verification fails, suspect the observation method first.
Evidence: PR bodies with command output, screenshots, or before-and-after numbers; a scripted way to launch and drive the app; end-to-end tests on the built artifact. Gap: "tests pass" as the only proof; no way for a cold agent to run the real surface.

**Fix root causes.** Reproduce first. Ask why until the mechanism is confirmed with runtime evidence. A guard that silences a crash is a symptom fix. A workaround that needs a paragraph to justify means the code is wrong. Fix the pattern, not the instance. For restart bugs, suspect stale persisted state before code.
Evidence: fix commits paired with a failing-first test; grep for the pattern after a fix finds no siblings. Gap: "fix crash" commits adding null checks; long workaround comments; the same symptom fixed several times.

**Attack the premise.** When two or more fixes sharing one premise have failed the same gate, write the premise down and measure which actors hold the imbalance before writing another fix.
Evidence: a census script next to a recurring flaky area. Gap: a stack of retries, rebalances, and compensations around one hot spot.

**Test behavior, not implementation.** Call the code as its users do and assert a literal expected result. If the test would pass when every imported function returned nothing, rewrite or delete it. Five shapes to grep for: weak or no assertion, mock-only or absence-only, self-referential expectation, constant pin, fixture asserting fixture. Prefer no new test over a bad test.
Evidence: sample tests pass the "returns nothing" check; mutation score if measured. Gap: suites heavy in `toBeDefined`, `toHaveBeenCalled`, or restated constants.

**Explain the number.** Before trusting or reporting a measurement, name what limits it from a profile, rule out that it measured something else (errors, skipped or cached work, an untuned side, noise, a piece too small to matter), and keep run count and spread with the number. If you cannot say why it is not twice as good, you do not know what you measured.
Evidence: perf PRs with repeated runs, median and range, a limiter, and artifacts. Gap: a single-run speedup with no profile.

**Sequence work into verifiable units.** Each unit ends in a check and lands on its own. Order tells the story: failing test then fix, subtraction then reshape, baseline then treatment, scaffold then feature. Never build on a broken base.
Evidence: commits that pass individually; test-only commits preceding fixes; stacked small PRs. Gap: mega-commits mixing removal and addition; checks run only at the end of a batch.

## Subtraction and scope

**Laziness protocol.** The most result from the least code. Look for deletions first. Keep call chains under three files. Put a repeated decision behind one source of truth. Before threading a new signal through layers, find a more direct path.
Evidence: refactor PRs with net deletions; shallow call graphs. Gap: pass-through parameters across many signatures; the same choice repeated in several modules.

**Subtract before you add.** Remove dead code, redundant validators, stubs, and speculative guards first, then build on the simpler base. Design for observed usage.
Evidence: deletion commits ahead of feature commits; unused-export tooling in the gate. Gap: guards with no spec behind them; stub docs and references.

**Minimize reader load.** Maintainability is the work a reader must do, measured as layers to trace and state to hold. Collapse one-caller wrappers and no-second-implementation adapters. Shrink mutable scope. Add a layer or state only if it removes at least as much elsewhere. The 30-second test: can a new reader answer "where does X come from" and "what can change X"?
Evidence: interfaces with one implementation; forwarding-only functions; module-level mutable state; hand-synced state instead of derived.

**Migrate callers, then delete legacy APIs.** Once a replacement exists, migrate every caller and delete the old path in the same wave. Adapters are exceptional and time-boxed. Applies only when no external consumer depends on compatibility.
Evidence: no deprecated symbols with internal callers. Gap: `legacy`, `old`, `v2` twins; re-export shims; old APIs outliving replacements by months.

**Outcome-oriented execution.** In planned rewrites, declare where temporary breakage is acceptable, keep high-signal checks on touched areas, and require full verification at the end. Do not preserve throwaway compatibility states.
Evidence: migration plans with declared breakage windows and a final verification step. Gap: "temporary" shims that became permanent.

## Design and structure

**Foundational thinking.** Get the data shape right before writing logic. Scaffold (CI, lint, test infrastructure, shared types) before features; tests before fixes. Ask what other actors share with this code.
Evidence: shared type modules that features import; infrastructure predating feature code in history.

**Model the domain.** Encode the domain in a structure (state machine, typed model, registry or table, discriminated union, reducer) instead of scattered conditionals. The tell that it was skipped: a feature that grows an if/else chain by one branch. Execution order is not ownership.
Evidence: registries keyed by an enum; exhaustive matches. Gap: long branch chains growing across PRs; boolean pairs that must agree; phase-named modules repeating the same rules.

**Redesign from first principles.** Integrate a new requirement as if it had been there from day one, then deliver incrementally. Propagate the change through types, docs, examples, and rationale.
Evidence: features integrated into the model rather than flagged onto it. Gap: special-case flags on an old design; docs and types that disagree after a change.

**Exhaust the design space.** With no precedent, build two or three structurally distinct candidates and compare before committing. A second flavor of the first shape does not count. Not for mechanical work or bug fixes with a clear target.
Evidence: design docs or PRs recording rejected alternatives.

**Experience first.** When implementation convenience conflicts with the user's experience, choose the user. Ship fewer, finished features. The user includes the colleague importing the library and the next maintainer.
Evidence: empty, error, and loading states covered; ergonomic internal APIs. Mostly judgment.

**Build the lever.** For non-trivial edits, migrations, or checks, build the script, codemod, or generator that does or proves it, then rerun it on the first hand-done unit and diff. One deterministic pass beats fanning out agents. Commit the lever when the work outlives the session.
Evidence: scripts next to large migrations; verification scripts a reviewer can rerun. Gap: large mechanical diffs with no generator.

## Types, boundaries, and state

**Type system discipline.** Make illegal states unrepresentable: sum types over bags of optionals, branded primitives, parsed boundaries, exhaustive matching, types derived from authoritative schemas, no lying casts. If you can write a comment explaining when a combination of fields is valid, the type is too loose.
Evidence: strict compiler settings; bans on `any` and double casts; exhaustiveness helpers; generated types used rather than duplicated. Gap: counts of casts and non-null assertions; parallel hand-written types.

**Boundary discipline.** Validate and narrow once at system boundaries, trust internal types, and keep business logic pure behind a thin shell. Do not re-export transport or storage types through the public surface.
Evidence: schema validation at routes, config, CLI, and IPC. Gap: defensive null checks deep inside services; framework imports inside domain modules.

**Make operations idempotent.** Commands, lifecycle steps, and loops converge to the same end state however many times they run and wherever they start. Three tests: what if it runs twice; what if the last run crashed partway; does rerunning converge? If any answer is "it depends on what was left behind", add a reconciliation step.
Evidence: upserts, rerunnable migrations and setup scripts, stale-lock handling, tests that run an operation twice.

**Separate before serializing shared state.** If concurrent actors might write the same file, branch, key, or object, first remove the sharing (one target per actor, merge at the read boundary). Serialize structurally only when a single writer is a real invariant. Instructions and conventions are not concurrency control.
Evidence: per-worker directories or branches; one writer per file in orchestration state. Gap: a shared state file written by several processes; intermittent race bugs.

## Leverage, autonomy, and learning

**Encode lessons in structure.** When you write the same instruction a second time, encode it as a type, lint, check, or script and delete the instruction. If it needs judgment, make the instruction prominent with an example of the failure. Pick the strongest mechanism available, because agents copy whatever the surrounding code does and a weaker guard becomes the next template.
Evidence: custom checks whose failure messages carry the contract; a rule-to-enforcer table in the instruction file. Gap: instruction files that repeat the same rule; review comments that recur on the same issue.

**Guard the context window.** Route bulk reads and large outputs to subagents and keep summaries in the main thread. Keep always-needed content inline in the skill; put rarely needed content in references. Size phases and cap files per phase.

**Never block on the human.** Proceed on reversible work and present the result. Pause only for irreversible actions: force-pushes to shared branches, deploys, data deletion, external messages. If a question could be answered by running something, run it instead of asking. Product direction is the human's; execution is not.
Evidence: instruction files that distinguish reversible from irreversible actions; hooks that block only destructive commands.
