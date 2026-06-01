---
name: fix
description: Verify and fix BLOCKING/HIGH code review findings from a prior review session via category-dispatch, then run project verification.
argument-hint: "<cr-dir> [--include-medium] [--include-tentative] [--include-justified] [--dry-run | --apply] [--category-only <name>] [--skip-verification]"
---

# Fix Code Review Findings

Category-dispatch fix flow for findings from a prior code review. Each finding is routed to one of four buckets based on its category/subcategory: **auto-fix**, **callsite-fix**, **specialized-fix**, or **manual-surface**. Premise findings, injection attempts, sensitive-file changes, and coverage gaps never auto-apply — they surface in a manual-action report instead.

The caller controls re-review cycles.

## Arguments

$ARGUMENTS

---

## Step 1: Parse Arguments and Load Findings

```json
TodoWrite([
  {"content": "Parse arguments and load findings", "status": "in_progress", "activeForm": "Parsing arguments"},
  {"content": "Categorize findings and print dispatch plan", "status": "pending", "activeForm": "Categorizing findings"},
  {"content": "Apply fixes per dispatch bucket", "status": "pending", "activeForm": "Applying fixes"},
  {"content": "Print manual-action report", "status": "pending", "activeForm": "Printing manual-action report"},
  {"content": "Run project verification", "status": "pending", "activeForm": "Running verification"},
  {"content": "Print summary", "status": "pending", "activeForm": "Printing summary"}
])
```

### Parse flags

Extract from `$ARGUMENTS`:

| Flag | Default | Effect |
|---|---|---|
| `<CR_DIR>` (positional) | auto-discover | Code-review session directory |
| `--include-medium` | off | Include MEDIUM findings (default: BLOCKING/HIGH only) |
| `--include-tentative` | off | Show TENTATIVE in manual-surface report (never auto-fixes) |
| `--include-justified` | off | Show JUSTIFIED-VALID in manual-surface report |
| `--dry-run` | off | Print dispatch plan and manual-action report; apply nothing |
| `--apply` | required in non-TTY | Required in non-interactive mode for code modification |
| `--category-only <name>` | unset | Restrict dispatch to a single category (e.g., `--category-only Correctness`) |
| `--skip-verification` | off | Skip the final `code:build-validator` step |

**`--dry-run` and `--apply` are mutually exclusive.** Both unset in non-interactive (no TTY) → print plan, exit without applying.

### Resolve CR_DIR

CR_DIR missing: auto-discover via `ls -td .closedloop-ai/code-review/cr-* | head -1`. No directories found → error `"No code review session found. Run a code review first."` → exit 1.

### Load review envelope

Read `<CR_DIR>/review_result.json` (canonical envelope per PLN-719). **There is no legacy fallback** — zero-release backward compat per PRD-409. File missing → error `"No code review output found in CR_DIR. Run a code review first."` → exit 1.

Findings live in:

| Bucket | What it contains | Default action |
|---|---|---|
| `envelope.verified[]` | CONFIRMED + DOWNGRADE + TENTATIVE + RE_ASSERTED + JUSTIFIED-INVALID | filter into dispatch |
| `envelope.justified[]` | JUSTIFIED-VALID (author defended, verifier confirmed) | exclude unless `--include-justified` (manual-surface only) |
| `envelope.rejected[]` | REJECTED by verifier | always exclude |
| `envelope.pending_verification[]` | Verifier didn't run on this finding (verifier failed, was deferred past budget, or `--no-verify` bypass) | include if severity matches; always **manual-surface** with the `pending_verification.md` template — `/fix` does NOT re-implement the verifier |
| `envelope.coverage_gaps[]` | System-scoped coverage findings | always include if severity matches; manual-surface bucket |

### Apply severity + verdict filter

For each candidate finding (from `verified[]` + `pending_verification[]` + `coverage_gaps[]`):

```
sev = finding.get("verifier_severity") or finding.get("severity")
include = (sev in {"BLOCKING", "HIGH"}) or (sev == "MEDIUM" and --include-medium)
```

Exclude if `verifier_verdict == "TENTATIVE"` unless `--include-tentative` (TENTATIVE → manual-surface only).

**Trust the envelope's verdict state.** Findings in `verified[]` were already audited upstream by the verifier (PLN-722); `/fix` does not re-run a second verification pass on them — that was the v2.12.x design and is removed in this revision. Findings in `pending_verification[]` are routed to **manual-surface** with a `pending_verification.md` template so the operator can decide whether to re-run the review, `--re-assert`, or fix by hand; `/fix` does not have, and should not have, its own parallel implementation of the verifier.

If `--category-only <name>` set, filter to that category only.

If no findings remain → print `"No actionable findings. Review complete."` → mark all todos completed → exit 0.

---

## Step 2: Categorize and Print Dispatch Plan

For each surviving finding, look up its dispatch bucket using the table below. Subcategory wins over category when both apply.

### Dispatch Table

| Category | Subcategory | Bucket | Notes |
|---|---|---|---|
| `Correctness` | — | **auto-fix** | Direct code edit at anchor line |
| `Code Quality` | — | **auto-fix** | DRY / maintainability — auto-fix at anchor |
| `Documentation` | — | **auto-fix** | Edit cited file:line |
| `Security` | — | **auto-fix** | Same flow as Correctness |
| `Hygiene` / `Repo Hygiene` | `ci_artifacts` | **auto-fix** | Delete or gitignore |
| `Hygiene` / `Repo Hygiene` | `path_leakage` | **auto-fix** | Replace path with env var / config reference |
| `Hygiene` / `Repo Hygiene` | `gitignore_drift` | **auto-fix** | Add gitignore entry |
| `Hygiene` / `Repo Hygiene` | `sensitive_files` | **manual-surface** | Never auto-modify (.env, credentials, .pem) |
| `Hygiene` / `Repo Hygiene` | (other / unset) | **auto-fix** | Treat as generic hygiene fix |
| `Premise` | `necessity` | **manual-surface** | Auto-revert unsafe |
| `Premise` | `cohesion` | **manual-surface** | Surface cited 5+ examples |
| `Premise` | `workaround` | **manual-surface** | Surface root cause location |
| `Premise` | `complexity` | **manual-surface** | Both over- and under-complexity surfaced for author input (the auto-fix path for over-complexity / single-use abstraction is deferred to a follow-up phase) |
| `Premise` | (any other) | **manual-surface** | Fail safe |
| `TestQuality` | `missing-coverage` | **manual-surface** | Specialized-fix flow (test-engineer) is **deferred to PLN-723 ship** |
| `TestQuality` | `weak-assertion` | **manual-surface** | Deferred to PLN-723 |
| `TestQuality` | `mock-faithfulness` | **manual-surface** | Deferred to PLN-723 |
| `TestQuality` | `missing-edge-case` | **manual-surface** | Deferred to PLN-723 |
| `TestQuality` | `bug-locking` | **manual-surface** | Never auto-fix even after PLN-723 |
| `TestQuality` | `test-deletion` | **manual-surface** | Never auto-fix even after PLN-723 |
| `ImpactAnalysis` | (any) | **manual-surface** | Callsite-fix flow is **deferred to PLN-726 ship** |
| `CompanionChange` | — | **manual-surface** | Companion content is context-dependent |
| `Coverage` | (any system_marker) | **manual-surface** | Re-run-or-acknowledge meta-action |
| `InjectionAttempt` | — | **manual-surface** | PR-author-controlled text — never code-edit |

**Drift-protection rule (applies to every bucket that would code-edit):** before applying ANY auto-fix, re-read `<finding.file>` and search for `<finding.code_snippet>` (or a normalized prefix when the snippet is multi-line) within `±3` of `<finding.line>`. If not found, emit `STALE_FINDING`, skip the fix, route to manual-surface bucket with a `code_snippet has drifted from cited location` note.

### Print plan

```
Fix Dispatch Plan
─────────────────
Auto-fix:        N findings  (breakdown by category)
Callsite-fix:    N findings  (deferred — surfaced as manual)  [appears only if PLN-726 not yet shipped]
Specialized:     N findings  (deferred — surfaced as manual)  [appears only if PLN-723 not yet shipped]
Manual surface:  N findings  (breakdown by category/subcategory)

Total auto-action: N findings.
Total requiring human action: N findings (surfaced in final report).

Interactive mode → Y/N prompt required.
Non-interactive → requires --apply to modify code; --dry-run for explicit no-op.
```

If `--dry-run` → render the manual-action report (Step 4) immediately, then exit 0.

If non-interactive and no `--apply` → render manual-action report, print `"Non-interactive run without --apply — dispatch plan shown above; no fixes applied."`, exit 0.

Interactive mode: prompt `Proceed? [y/N]` with no timeout (the prior auto-yes-after-5s behavior is removed). Default `N`.

---

## Step 3: Dispatch and Apply Fixes

### 3a. Auto-fix bucket

Group surviving auto-fix findings by file. Apply **sequentially** within file (later fixes see earlier results); files run sequentially overall to keep the run-loop reproducible.

For each finding, perform the mandatory drift check first:

```bash
# Drift check (inline shell — no helper subcommand needed)
grep -Fn "<first non-empty line of finding.code_snippet>" "<finding.file>" | \
  awk -F: '$1 >= <line - 3> && $1 <= <line + 3>' | head -1
```

No match → tag the finding `STALE_FINDING`, move it to the manual-surface bucket with note `code_snippet has drifted from cited location`, skip to next.

Match → launch `Agent` with `subagent_type: "general-purpose"`, `model: "sonnet"`:

```
Fix this code review finding. Minimal change only — no refactoring, no new features, no unnecessary error handling.
File: {file} | Line: {line}
Issue: {issue}
Explanation: {explanation}
Recommendation: {recommendation}

Read the file, apply the fix, confirm what changed.
```

Record modified files for the Step 6 summary.

### 3b. Callsite-fix bucket (DEFERRED — PLN-726)

ImpactAnalysis findings have an `external_impact[]` list of affected callsites in untouched files. The dedicated multi-file callsite update flow ships with PLN-726 (Cross-File Impact Analysis). Until then:

- Every ImpactAnalysis finding routes to **manual-surface** with template `templates/impact_semantic_change.md`.
- The manual-surface entry includes the anchor + every `external_impact[]` entry so the operator can apply the updates by hand.

### 3c. Specialized-fix bucket (DEFERRED — PLN-723)

TestQuality findings need a `test-engineer` subagent that ships with PLN-723. Until then:

- All TestQuality findings (including the four that would eventually auto-fix) route to **manual-surface** with template `templates/testquality_specialized.md`.
- `bug-locking` and `test-deletion` keep their permanent manual-surface routing using `templates/testquality_bug_locking.md` and `templates/testquality_test_deletion.md`.

### 3d. Manual-surface bucket

For each finding in the manual-surface bucket, look up the template per the routing table:

| Routing | Template file |
|---|---|
| `Premise/necessity` | `templates/premise_necessity.md` |
| `Premise/cohesion` | `templates/premise_cohesion.md` |
| `Premise/workaround` | `templates/premise_workaround.md` |
| `Premise/complexity` | `templates/premise_complexity.md` |
| `TestQuality/bug-locking` | `templates/testquality_bug_locking.md` |
| `TestQuality/test-deletion` | `templates/testquality_test_deletion.md` |
| `TestQuality/*` (other, pre-PLN-723) | `templates/testquality_specialized.md` |
| `ImpactAnalysis/*` (pre-PLN-726) | `templates/impact_semantic_change.md` |
| `CompanionChange/*` | `templates/companion_change.md` |
| `Coverage/*` | `templates/coverage_gap.md` |
| `InjectionAttempt/*` | `templates/injection_attempt.md` |
| `Hygiene/sensitive_files` | `templates/hygiene_sensitive.md` |
| Any finding from `envelope.pending_verification[]` (verifier didn't run) | `templates/pending_verification.md` |
| (no matching template — e.g., a future category) | `templates/_generic.md` |

Read each template once (Read tool, path `<CLAUDE_PLUGIN_ROOT>/skills/fix/templates/<name>.md`), then substitute placeholders `{file}`, `{line}`, `{severity}`, `{category}`, `{subcategory}`, `{issue}`, `{explanation}`, `{recommendation}`, `{code_snippet}`, plus category-specific placeholders documented in each template. Missing placeholder data → leave the placeholder visible so the operator sees the gap (do not silently drop).

Buffer each rendered entry for the Step 4 report.

---

## Step 4: Manual-Action Report

After Step 3 completes (or immediately after Step 2 if `--dry-run` / non-interactive without `--apply`), print:

```markdown
## Manual Action Required

The following findings need human action — they were not auto-fixed because their category requires operator judgment, the supporting flow has not shipped yet, or auto-fix would be unsafe.

[one rendered template entry per manual-surface finding, in dispatch order]
```

For `STALE_FINDING` entries, prepend a one-line note:

```
> ⚠️  STALE_FINDING — code_snippet has drifted from cited location at {file}:{line}. The finding may already be fixed, or the line may have moved. Verify before action.
```

If the manual-surface bucket is empty, print `_No findings require manual action._`.

---

## Step 5: Run Project Verification

Skipped when `--skip-verification` set or when no auto-fix bucket entries succeeded (nothing changed).

Launch `Agent` with `subagent_type: "code:build-validator"`:

```
Run all validation commands (test, lint, typecheck, build). Report VALIDATION_PASSED, VALIDATION_FAILED, or NO_VALIDATION.
```

Do NOT run validation commands directly — `build-validator` discovers and runs them.

- **PASSED** or **NO_VALIDATION** → proceed to Step 6
- **FAILED** → launch `general-purpose` subagent (`model: "sonnet"`) to fix, re-run `build-validator`. Max 5 attempts. Warn and proceed on persistent failure.

---

## Step 6: Summary

Print the structured summary:

```markdown
## Fix Summary

### Auto-fixes applied (N)
| Category | Findings | Files modified |
|---|---|---|
| Correctness | n | file1, file2 |
| Hygiene (auto-safe) | n | .gitignore |
| ... | | |

### Deferred (await future plans)
| Bucket | Findings | Status |
|---|---|---|
| Callsite-fix | n | Routed to manual-surface — PLN-726 not yet shipped |
| Specialized-fix | n | Routed to manual-surface — PLN-723 not yet shipped |

(Omit the Deferred table if both counts are zero.)

### Manual action required (N)
[short list — one line per finding pointing at file:line + category — full templates in Step 4 above]

### Verification
| Status | Detail |
|---|---|
| Build/Tests/Lint/Type check | PASSED / FAILED / NO_VALIDATION / SKIPPED |

### Telemetry
| Metric | Value |
|---|---|
| Findings received | N |
| Auto-fixed | N |
| Manual surface | N |
| Stale findings (drifted) | N |
| Pending-verification routes | N (findings without upstream verifier_verdict surfaced to operator) |
| Total /fix duration | Hh Mm Ss |
```

Mark all todos `completed`.

---

## Notes for run-loop.sh and other callers

The default mode is now **dry-run when no TTY**. `run-loop.sh` must invoke this skill with `--apply` to retain the previous auto-apply behavior:

```bash
"$CLAUDE" -p "/code-review:fix $cr_dir --apply"
```

`/code-review:fix $cr_dir` without `--apply` from a non-interactive context will print the dispatch plan + manual-action report and exit without modifying code — by design.
