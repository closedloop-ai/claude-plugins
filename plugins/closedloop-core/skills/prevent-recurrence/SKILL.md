---
name: prevent-recurrence
description: Use when fixing a bug or an accepted code-review finding caused by an agent's mistake or by a pattern agents repeat; when a reviewer catches an agent error; when someone says "this keeps happening" or asks how to stop it; or in post-incident follow-up. Fixes the instance (failing-first test where practical), finds and fixes the same mistake elsewhere, then adds the strongest prevention the repository supports (types or architecture, static checks, a guard test, an owning AGENTS.md rule, advisory notes). Not for ordinary feature work.
---

# Prevent Recurrence

A fixed instance is not a fixed mistake. Use this procedure whenever a bug or an
accepted review finding was caused by an agent's mistake, or by a pattern agents keep
repeating, so the same class of mistake cannot come back unnoticed. It works in any
repository and any workflow; it assumes nothing about the repository beyond what you
find in step 3.

Skip it for ordinary feature work, rejected review findings, and failures with no
mistake behind them (an outage, a flaky runner) unless they expose a missing guard.

## 1. Fix the instance

1. Reproduce the failure. Where a test is practical, write one at the observable
   surface (public function, route, CLI, rendered output) that fails on the current
   code, then fix the code and watch it pass. If no test is practical (prose, config,
   a one-off migration), say why in the closeout.
2. Write the mistake as a class in one sentence: "did X when Y, causing Z". The class
   sentence, not the instance, drives the rest of this procedure.

## 2. Find the class

1. Search the codebase for the same shape: the same call, import, literal, pattern,
   or missing pairing; parallel implementations of the same behavior (a twin path for
   retries, recovery, another platform, another plugin); and code written from the
   same template. Use text search plus any code-intelligence tool the session has
   (callers, importers, symbol search).
2. Fix the other instances in the same change when they are small and in the same
   area. Otherwise list each one with its path for the follow-up in step 6.
3. Keep the search commands. They go in the closeout so a reviewer can rerun them, and
   a search that found every instance with few false positives is often the start of
   a static check in step 4.

## 3. Learn the repository's own mechanisms

Find what exists before choosing a prevention; never assume a mechanism.

- Read the root and nearest AGENTS.md and CLAUDE.md (or equivalent) files for the
  changed paths, plus contributing and testing docs. Note any rule that already
  covers this mistake; if one exists, step 5 applies.
- Find the lint configuration and any custom rules, source-gate or policy scripts,
  allowlists and baselines, and what CI actually runs (workflow files, package
  scripts, Makefile, justfile).
- Learn the test conventions: where tests live, how they are named, and whether guard
  or contract tests already exist (tests that scan source files or iterate a registry
  are the usual home for a new guard).
- Read review checklists, PR templates, and review prompt packs if the repository has
  them. If a review already classified the finding's prevention (for example a
  `workflow-code-review` automation status), start from that classification and verify
  it against what you found.

## 4. Choose the highest rung that can catch it

Work down this trust ladder and stop at the first rung that can catch the class. Higher
rungs enforce; lower rungs only advise.

| Rung | What it does | Fits when |
|---|---|---|
| 1. Architecture or types | Makes the bad state impossible to write | The mistake is an invalid combination, a missing case, a raw value where a typed one belongs, or an API that is easy to misuse and can be reshaped so the safe path is the only path |
| 2. Static analysis | The repository's lint rules or source gates reject it | The mistake has a syntactic shape a check can see: a call, import, literal, file location, or a required pairing in one file |
| 3. Guard test | A targeted test fails if it returns | No syntactic shape, but a test can observe it at a real surface: an output, a contract, an invariant over every registered item, parity between twins |
| 4. Owning AGENTS.md rule | Tells the next agent working there | Avoiding it takes judgment no check can encode |
| 5. Memory or notes hint | Advisory context only | Useful knowledge that is not a code rule (environment pitfalls, external system behavior); never enforcement |

Recognize the rung by asking, in order:

1. Could the code be shaped so the mistake does not compile or cannot be constructed?
2. Could a check find every instance from its text alone, with few false positives?
3. Can a test observe the mistake at a public surface without mocking the thing that
   went wrong? Prefer a test that enumerates all instances (every route, every
   registry entry, every skill file) over one that pins only the fixed one.
4. Does it need judgment? Then it is a rule, unless step 5 applies. Put it in the
   instruction file closest to the owning code, not the root by default: the nearest
   existing AGENTS.md (or the file the repository treats as canonical when AGENTS.md
   and CLAUDE.md both exist), or a new nested one only if the repository already uses
   nested instruction files. Keep it to one or two lines: the rule, why, and how to
   check.
5. Otherwise, a memory or notes hint, if the repository or workflow keeps one. A hint
   is never the only prevention for a correctness mistake: pair it with a rung 4 rule
   or a follow-up proposing a higher rung.

If the fitting rung needs a large change outside the current scope, add the highest
rung that fits now and propose the higher one as a follow-up. A lower rung may
accompany a higher one (for example, a one-line rule pointing at a new lint rule), but
do not stack rungs without a reason.

For rungs 1 to 3, prove the prevention works: temporarily reintroduce the mistake (or
run the check against the pre-fix code) and confirm the type error, check, or test
fails, then restore. A check that never failed has not been shown to catch anything.
Rungs 4 and 5 cannot fail; say so in the closeout rather than claiming proof.

Extend an existing mechanism before creating a new one, and do not introduce a new
toolchain because of one bug; propose it as a follow-up instead.

Never loosen an existing check to make a change pass: no disabled rules, new
suppressions, widened thresholds, or skipped tests. Allowlists and baselines only
shrink. If a new check cannot pass yet, start it with an explicit list of the remaining
known instances from step 2, which may only shrink, and file the follow-up to clear it.

[references/rung-examples.md](references/rung-examples.md) has labeled examples of each
rung.

## 5. A rule already existed

If a written rule already covered this mistake and was not followed, do not add
another rule saying the same thing. Move up a rung: propose or add the static check
or guard test that enforces it. If it truly cannot be mechanized, fix why it was
missed (wrong file, too far from the code, buried in prose) by moving or tightening
the existing rule rather than duplicating it.

## 6. Scope

- Include the prevention in the same change when it is small and in the same area: a
  few files, no new toolchain, no behavior change outside the touched code.
- Otherwise file a ticket in the tracker the repository or workflow uses, or propose a
  follow-up in the PR description or final report when you cannot file one. Include
  the class sentence, the instances with paths, the chosen rung and why, and the
  proposed check or rule.
- Never drop it silently. The closeout always names the rung added or proposed, or why
  none applies.

## 7. Record the event, only where a log exists

If the repository or the workflow you are running in documents a correction-event
log, lessons file, or learning store, record this event there in its documented
format. Find it through the instruction files from step 3 or the workflow's own
instructions. Do not create one, and do not assume one exists.

## Closeout

Report this block in the PR description or final result:

```text
Prevention
- Class: <one sentence>
- Instances: fixed <paths> | listed for follow-up <paths> | none found
- Search: <commands used>
- Rung: <rung> via <file or mechanism>
- Proof: <evidence it failed on the reintroduced mistake> | advisory rung, no proof possible
- Why not higher: <reason>
- Follow-up: <ticket or proposal> | none
- Event recorded: <where> | no log defined
```
