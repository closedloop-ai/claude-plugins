# Audit areas

One read-only subagent (parallel worker) per area. Each brief carries the same skeleton; only the questions change. Without delegation, work the areas one at a time with the same brief and the same notes file per area.

## Brief skeleton

```text
GOAL: audit <area> of the repository at <path> for the repo-hardening plan. Read-only.
SCOPE: <directories or file globs to cover; what to leave alone>
QUESTIONS: <the area's questions below>
EVIDENCE: every claim carries path:line, a commit SHA, a PR number, or a command and its output. Label inference as inference. Never guess from file names; open the file.
OUTPUT: write notes to <notes-file>. Sections: Findings (one bullet each, evidence first), Mechanisms that exist (what the repo already enforces and how), Gaps (what nothing enforces), Open questions. Under 150 lines. No file dumps; pointers only.
TIMEBOX: <turns or minutes>
FORBIDDEN: editing any file in the repository, running anything other than git and read commands in it (no installs, builds, or test runs).
REPORT: reply with five lines: top three findings, the strongest existing mechanism, the biggest gap.
```

Give each subagent a different notes file so they never write to the same path.

## Area 1: instruction files

Files: AGENTS.md and any harness-specific agent instruction files, CONTRIBUTING, README sections aimed at contributors, PR templates, review checklists, any nested instruction files.

- Which rules exist, and for each: is it enforced by a type, a check, a test, or nothing? Build the rule-to-enforcer table. A rule with no enforcer is a finding.
- Which rules are duplicated across files, contradict each other, or sit far from the code they govern?
- Which rules restate something a lint already catches (delete candidates)?
- Is there a documented place where corrections, lessons, or known pitfalls are recorded? Is it used?
- Does the repo say how to run, test, and verify a change on the real surface, with commands? Does it say what proof a PR must carry?

## Area 2: static checks and gates

Files: lint configs, custom lint rules, source-gate or policy scripts, allowlists and baselines, formatter config, pre-commit hooks, package scripts, Makefile or task runner.

- What runs locally, what runs in CI, and are they the same command?
- Custom rules: does each failure message name the fix (the file, type, or helper to use instead)?
- Allowlists and baselines: do they only shrink? Any that grew recently (git log on the file)?
- Suppressions: count disable comments and casts by type. Which rules are suppressed most? Any suppression without a reason?
- Which recurring review comments or instruction-file rules have a syntactic shape a check could catch but none does?

## Area 3: types and boundaries

- Compiler strictness settings and any opt-outs per package.
- Boundary validation: is external data parsed into domain types at entry points (routes, CLI args, config, IPC, queues), or re-validated deep inside?
- Illegal states: bags of optional fields that must agree, boolean pairs, string unions where a discriminated union belongs, hand-maintained parallel types next to generated ones.
- Wire or storage types re-exported through public surfaces.
- Module ownership: state with more than one writer, internals importable from anywhere, two ways to do one task, hand-synced lists.
- Idempotency of setup, migration, and lifecycle commands: what happens if run twice or after a crash?

## Area 4: tests

- Layout, naming, runners, and how long the suite takes, from CI logs or run metadata rather than by running it.
- Behavior versus implementation: sample tests and apply the check "would this still pass if every imported function returned nothing?" Count the shapes: weak assertion, mock-only, self-referential, constant pin, fixture asserts fixture.
- Guard or contract tests that enumerate all instances (every route, every registry entry, every file of a kind). Are there natural homes for new ones?
- Coverage of real surfaces: is there any test or script that drives the built artifact (CLI, UI, API) end to end? Is there a documented way for an agent to launch and drive the app?
- Flaky tests: skipped, retried, or quarantined, and for how long.
- Bug fixes in history: did they land with a failing-first test? Sample ten.

## Area 5: CI and merge flow

- Workflow files: what gates merge, what is advisory, what is skipped on some paths.
- Required checks versus optional. Can a red check be bypassed?
- Merge method, stacking conventions, branch protection as far as readable from config.
- Build and test time per PR from CI run metadata; parallelism; caching that could hide staleness.
- Does CI run the same commands as the local gate? Any CI-only or local-only steps?
- Deploy or release steps that are irreversible, and what guards them.

## Area 6: review and verification habits

Sample the last 30 to 50 merged PRs and their review threads. Without access to the forge, mark this area not assessed and name the access it needs.

- What proof do PR bodies carry? Count: none, "tests pass", command output, screenshots or recordings, before-and-after numbers.
- Which review comments recur across PRs? Group by theme. Each recurring theme is a candidate mistake class.
- How often are review findings dismissed, and with what reason?
- Do perf claims carry run counts, variance, and a named limiter?
- Is verification on the real surface documented or scripted anywhere?

## Area 7: history and recurring mistakes

Use git log, reverts, "fix", "hotfix", "revert", "workaround", "temporary", "TODO", "HACK", "FIXME", and comments that explain workarounds.

- Mistake classes that happened at least twice. For each: instances with commits or paths, the apparent cause, and whether an instruction-file rule already covered it (a rule that existed and was not followed is an enforcement gap, not a documentation gap).
- Symptom fixes: null guards or retries added without a root-cause change. Restart or state bugs.
- Legacy dual paths: deprecated symbols with live callers, `v2` or `old` twins, shims older than a few months.
- Large mechanical diffs with no script or codemod next to them.
- Areas with repeated churn or repeated reverts.
- Where agents visibly went wrong: commits or PRs authored by agents that were reverted or heavily corrected, if attributable.
