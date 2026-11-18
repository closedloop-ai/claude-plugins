---
name: prevent-recurrence
description: Use when correcting an issue or failure reveals a reusable prevention lesson, including code, setup, measurement, validation, workflow, agent mistakes, or accepted code-review findings; when someone says "this keeps happening" or asks how to stop it; or in post-incident follow-up. Fixes the instance (failing-first test where practical), finds and fixes the same mistake elsewhere, then adds the strongest prevention the repository supports (types or architecture, static checks, a guard test, an owning instruction rule, advisory notes). Not for ordinary feature work, rejected findings, or external outages/flaky infrastructure with no agent or system mistake.
---

# Prevent Recurrence

A fixed instance is not a fixed mistake. Use this whenever correcting an issue or
failure reveals a reusable lesson. The correction may involve code, setup, measurement,
validation, workflow, or another agent or system mistake. It assumes nothing about the
repository beyond step 3's findings.

Skip it for ordinary feature work, rejected review findings, and external outages or
flaky infrastructure with no agent or system mistake, unless they expose a missing
guard.

## 1. Fix the instance

1. Reproduce the failure. Where practical, write a test at the observable surface
   (public function, route, CLI, rendered output) that fails on the current code, then
   fix the code and watch it pass. If not (prose, config, a one-off migration), say why
   in the closeout.
2. Write the mistake as a class in one sentence: "did X when Y, causing Z". The class
   sentence, not the instance, drives what follows.

## 2. Find the class

1. Search for the same shape: the same call, import, literal, pattern, or missing
   pairing; twin implementations of the same behavior (retries, recovery, another
   platform); and code from the same template, with text search and any
   code-intelligence tool available.
2. Fix the other instances in the same change when they are small and in the same
   area. Otherwise list each one with its path for step 6.
3. Keep the search commands for the closeout; one that found every instance with few
   false positives can seed a step 4 static check.

## 3. Learn the repository's own mechanisms

Find what exists before choosing a prevention; never assume a mechanism.

- Read the root and nearest instruction files for the changed paths, plus contributing
  and testing docs. If a rule already covers this mistake, step 5 applies.
- Find the lint configuration, custom rules, source-gate or policy scripts, allowlists
  and baselines, and what CI runs.
- Learn the test conventions and existing guard tests (tests that scan source files
  or iterate a registry usually host a new guard).
- Read review checklists and PR templates; start from any prevention a review already
  classified, and verify it.
- Harness check: find which agent harnesses work here (`CLAUDE.md`, `.claude/`,
  `AGENTS.md`, `.codex/`, `.agents/`) and which instruction files each loads for the
  changed paths, and when:
  - Claude Code at launch: `CLAUDE.md` from its working directory up (`AGENTS.md` if
    there is none) and `.claude/rules/**/*.md` without `paths:`. On demand: a
    subdirectory's `CLAUDE.md` on a read, write or edit there (its `AGENTS.md` on a
    read, if it has no `CLAUDE.md`), and a `paths:` rule on a read, write or edit of a
    matching file.
  - Codex at start, once per run, in trusted projects only: one `AGENTS.override.md`,
    `AGENTS.md` or configured fallback per directory from the project root to its
    working directory, up to `project_doc_max_bytes` (default 32768) in total. Not loaded:
    files below its working directory, path-scoped text, or `.claude/rules` (its
    `.rules` files are command policy).
  - Both pass a PreToolUse or PostToolUse hook's `additionalContext` to the model.

## 4. Choose the highest rung that can catch it

Work down this trust ladder and stop at the first rung that can catch the class. Higher
rungs enforce; lower rungs only advise.

| Rung | What it does | Fits when |
|---|---|---|
| 1. Architecture or types | Makes the bad state impossible to write | Code can be reshaped so the mistake cannot compile or be constructed: an invalid combination, a missing case, a raw value instead of a typed one |
| 2. Static analysis | The repository's lint rules or source gates reject it | A check finds every instance from text alone (a call, import, literal, location, or pairing in one file) with few false positives |
| 3. Guard test | A targeted test fails if it returns | A test observes it at a public surface without mocking what went wrong (output, contract, invariant over every registered item, twin parity); prefer enumerating every instance |
| 4. Owning instruction rule | Tells the next agent working there, in a file its harness loads | Avoiding it takes judgment no check can encode |
| 5. Memory or notes hint | Advisory context only | Useful knowledge that is not a code rule (environment pitfalls, external system behavior); never enforcement |

For rung 4 (unless step 5 applies), write one or two lines (the rule, why, how to
check) where the harness check shows each harness loads them:

- Default: the nearest owning `AGENTS.md` (or the repository's canonical file), not the
  root; a new nested one only where nesting already exists.
- A path-scoped `.claude/rules` file only for a lesson keyed to a file pattern that
  crosses directories (such as `**/*.test.ts`). Where another harness runs, it adds to
  the `AGENTS.md` text, never replaces it. Never move existing `AGENTS.md` lines into
  rules.
- For a high-value lesson keyed to file paths, a shared PreToolUse or PostToolUse hook
  returning `additionalContext` reaches both harnesses (Codex: only in trusted projects,
  once reviewed); extend one the repository registers, if any. It stays advisory.

Size budget check before appending: Claude cuts a file it loads on demand past 40,000
characters on a 200K context window; Codex truncates its chain past
`project_doc_max_bytes` (check every Codex config layer; budget against the
smallest); Claude's guidance: under 200 lines per `CLAUDE.md`. Near a limit, tighten
an existing line or propose a split instead.

Rung 5 needs a notes store the repository or workflow keeps and never stands alone for
a correctness mistake; pair it with a rung 4 rule or higher-rung follow-up.

If the fitting rung is too large for this change, add the highest that fits now and
propose the higher as a follow-up; stack rungs only for a reason (a one-line rule
pointing at a new lint rule).

For rungs 1 to 3, prove the prevention works: temporarily reintroduce the mistake (or
run the check against the pre-fix code), confirm the type error, check, or test fails,
then restore. Rungs 4 and 5 cannot fail; say so rather than claiming proof.

Extend an existing mechanism before creating one; propose a new toolchain as a
follow-up rather than adding it for one bug.

Never loosen an existing check to make a change pass: no disabled rules, new
suppressions, widened thresholds, or skipped tests. Allowlists and baselines only
shrink. A new check that cannot pass yet starts with an explicit, shrink-only list of
step 2's known instances, plus a follow-up to clear it.

[references/rung-examples.md](references/rung-examples.md) has labeled examples of each
rung.

## 5. A rule already existed

If a written rule already covered this mistake, do not add another. Move up a rung: add
or propose the check or guard test that enforces it. If it cannot be mechanized, fix
why it was missed instead of duplicating it:

- Ignored: wrong file, far from the code, or buried in prose. Move or tighten it.
- Harness never loaded it: Codex's working directory was above the file, the project
  was untrusted, the text was cut off for size, or only one harness reads its file
  (`.claude/rules`; a `CLAUDE.md` with no `AGENTS.md` copy, unless Codex config names it
  in `project_doc_fallback_filenames`). Fix placement or size, not another copy.

## 6. Scope

- Include the prevention in the same change when it is small and in the same area: a
  few files, no new toolchain, no behavior change outside the touched code.
- Otherwise file a ticket in the repository's or workflow's tracker, or, when you
  cannot, propose a follow-up in the PR description or final report. Include the class
  sentence, instance paths, the chosen rung and why, and the proposed check or rule.

## 7. Record the event, only where a log exists

If the repository or your workflow documents a correction-event log, lessons file, or
learning store, record this event there in its format. Never create or assume one.

## Closeout

Report this block in the PR description or final result:

```text
Prevention
- Class: <one sentence>
- Instances: fixed <paths> | listed for follow-up <paths> | none found
- Search: <commands used>
- Rung: <rung added or proposed> via <file or mechanism> | none: <why>
- Harness reach: per harness, <harness>: <file> (at launch, on demand, or not loaded) | not rung 4
- Proof: <evidence it failed on the reintroduced mistake> | advisory rung, no proof possible
- Why not higher: <reason>
- Follow-up: <ticket or proposal> | none
- Event recorded: <where> | no log defined
```
