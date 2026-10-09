# Plan template (Markdown twin)

The HTML page built from [../assets/plan-template.html](../assets/plan-template.html) is the primary output. Write this Markdown version next to it with the same base name so agents can consume it later. Same sections, same content. Keep it an outline. Every finding carries evidence. Prose is short; tables are fine where they compress.

Label every evidence item measured, inferred, or guess. Severity for findings: high (correctness, data, security, or a mistake class seen three or more times), medium (seen twice, or costly when it hits), low (hygiene).

```markdown
# <repo> hardening plan

Analyzed: <path or remote>, commit <sha>, <date>. Scope: <what was and was not examined>.

## Summary

Three to six sentences. The strongest things the repo already does, the top three gaps, and the recommended first unit.

## What the repo already enforces

Table: mechanism | what it catches | where (path) | rung. This is the baseline the plan builds on and the list of things not to duplicate.

## Findings

Ordered by priority (frequency times cost of the mistake). For each:

### F<n>. [<high|medium|low>] <one-line class sentence: did X when Y, causing Z>
- Evidence: <path:line, commits, PRs, review comments, command output>. Inference is labeled.
- Principle: <name from the lens> and how the repo falls short of it.
- Existing rule, if any: <file and line>, and why it did not hold.
- Proposed rung: <1 to 5> via <mechanism>, located at <path or file>.
- Why not higher: <reason>.
- Proof: <how the mechanism will be shown to fail on the past mistake>.
- Deletions this enables: <rules, code, or tests that become redundant>.

## Sequence

Ordered units of work, each independently reviewable and landable. Combine small findings into one unit; split only large ones. For each unit:

### U<n>. <title>
- Covers: F<a>, F<b>.
- Goal and done check: <falsifiable>.
- Changes: <files or directories touched>.
- Deletes: <rules, code, tests, or shims removed>.
- Proof to attach to the PR: <command output, failing-then-passing check, before-and-after numbers>.
- Size: <small, medium, large> and dependencies on other units.

## Quick wins versus structural changes

Two lists of unit numbers: quick wins (land in the first week) and structural changes (need design or a human decision).

## What not to do

Tempting changes the evidence does not support, with the reason: a new toolchain for one class, rules that restate a lint, broad rewrites, process added where a check would do.

## Decisions for a human

Each with options and a recommendation. Product or preference calls only; anything observable by running something was observed and is reported as a finding.

## Not assessed

Areas or principles with no evidence either way, and what it would take to assess them.
```
