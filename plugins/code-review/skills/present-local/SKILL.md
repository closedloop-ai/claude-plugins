---
name: present-local
description: Render the operator-facing local-mode code review results at stage_29_present. Covers Gate A hygiene-only early-exit format, BLOCKING/HIGH/MEDIUM section templates, Justified Findings (PLN-721), Dismissed Findings (PLN-722), Verifier Stats footer (PLN-773), operator-flag descriptions, override precedence rule for stage_22b, Validation Summary, and final Summary. Invoke when MODE=local AND stage_29_present is reached, OR when Gate A early-exit (flags.hygiene_only==true) fires. Do NOT use for GitHub mode — see prompts/github-review.md.
---

# Local-Mode Code Review Presenter

This skill is the canonical presenter for `/code-review` local mode. It is split out of `commands/start.md` so the orchestration spine stays lean; load it whenever the orchestrator reaches a presentation point in local mode.

The two entry conditions:

1. **Gate A early-exit** — `flags.hygiene_only == true` after `stage_12_hygiene`. Use the "Hygiene Findings (Gate A presentation)" section below and EXIT. Do NOT run footer or verdict.
2. **Standard stage_29_present** — `MODE=local`. Use the "Local Mode: Present Results" section below for the full presentation pipeline.

---

## Hygiene Findings (Gate A presentation)

Reached only when `flags.hygiene_only == true`. Parse `<CR_DIR>/hygiene.json` and present:

```markdown
# Hygiene Check Results

**Scope:** [staged/branch/files]
**Files Checked:** [count]
**Mode:** Hygiene-only (no LLM review)

---

## Repo Hygiene ([count])

[List hygiene findings — same format as Local Mode: Present Results hygiene section]

---

**Summary:** [count] hygiene issues found. No LLM-based review was performed.
```

If MODE=github, write the hygiene findings to `.closedloop-ai/code-review-summary.md` (same summary file path) and `.closedloop-ai/code-review-findings.json` (findings only contain hygiene items). No inline comments are posted for hygiene-only runs unless findings exist.

Mark "Present hygiene findings" `completed` and **EXIT**. Do NOT run footer or verdict — both depend on artifacts (`findings_validated.json`, `review_result.json`) that hygiene-only never produces, and `stage_28_verdict.on_failure == "abort"` would crash the walker.

---

## Local Mode: Present Results (stage_29_present, MODE=local)

Mark "Present findings by severity" `in_progress`.

If `normalization_warnings > 0` in `findings_validated.json`, include after the validation summary:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
```

**Reviewers and Model Routing lines are conditional on `FAST_PATH`:**

- **If `FAST_PATH == false`:**
```markdown
**Reviewers:** Bug Hunter A, Bug Hunter B, Unified Auditor, Premise Reviewer
[+ domain specialist if triggered]
**Model Routing:** [Small/Medium/Large] — [model assignments summary]
```

- **If `FAST_PATH == true`:**
```markdown
**Reviewers:** Fast Path Reviewer (single-agent mode)
**Model Routing:** Fast path — <MODEL> single reviewer
```

Then continue with:

---

## Repo Hygiene ([count])

[List any hygiene findings from deterministic checks]

### Finding Title
**File:** `path/file.ts:line`
**Issue:** [description]
**Recommendation:** [fix]

---

## BLOCKING ([count])

[List all blocking issues]

### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]
**Recommendation:** [fix]

---

## HIGH ([count])

[List all high priority issues — same format]

---

## MEDIUM ([count])

[List all medium priority issues — same format]

---

## Justified Findings (PLN-721)

Read `<CR_DIR>/review_result.json` → `justified[]`. If empty, omit the section. If non-empty, render below with collapsible details so the reviewer can audit the justification audit. Cap at 20 displayed; if more, append a pointer line to `review_result.json.justified[]`.

For each justified finding:

```markdown
### [{ORIGINAL_SEVERITY} justified] {FILE}:{LINE} — {ISSUE_HEAD}
**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Subcategory:** `{SUBCATEGORY}` (Premise findings only)
**Verifier verdict:** JUSTIFIED-VALID
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original concern:** [verbatim from finding.issue]

**Author's justification:**
> [verbatim from finding.justification.text]
>
> — cited at `{finding.justification.source}` by `{finding.justification.claimed_by_reviewer}`

**Verifier reasoning:** [verbatim from finding.verifier_reasoning — explains why J1 + J2 both passed]
```

After all justified findings (or the cap), print:

```
ℹ️ {N} finding(s) were emitted by reviewers but absorbed by author justification comments the verifier independently validated. Inspect each; if you disagree with a dismissal, the original concern is preserved in review_result.json.justified[].
```

---

## Dismissed Findings (PLN-722)

Read `<CR_DIR>/review_result.json` → `rejected[]`. If empty, omit the section. If non-empty, render verbose-by-design (humans must evaluate, not skim) and sort BLOCKING dismissals first, MEDIUM last. Cap at 20 displayed; if more, append a pointer line to `review_result.json` for the full list.

For each rejected finding:

```markdown
### [{ORIGINAL_SEVERITY} dismissed] {FILE}:{LINE} — {ISSUE_HEAD}
**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Verifier verdict:** REJECTED (rejection_class: `{REJECTION_CLASS}`)
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original issue:** [verbatim from finding.issue]

**Verifier reasoning:** [verbatim from finding.verifier_reasoning — usually 1-3 paragraphs]

**Evidence checks:**
- ✓ {check.claim} — verified at {check.source}
- ✗ {check.claim} — {check.actual_read} ({check.source})

(If `finding.verifier_verdict == "TENTATIVE"` because of a sensitive-path escalation rather than a true REJECTED → TENTATIVE rewrite, that finding belongs in the primary BLOCKING/HIGH/MEDIUM sections above with a `[verifier uncertain — sensitive path]` annotation, NOT here.)
```

After all rejected findings (or the cap), print:

```
ℹ️ {N} finding(s) were emitted by reviewers but disproved by the verifier with cited evidence. Inspect each; if you disagree with a dismissal, the original finding is preserved in review_result.json.rejected[].
```

If `review_result.json.pending_verification[]` is non-empty, append a one-line note:

```
⚠️ {M} finding(s) were eligible for verification but no verifier output landed on disk (agent timeout, --no-verify, or budget overflow). Treat them as unverified and re-review by reading review_result.json.pending_verification[].
```

---

## Verifier Stats (PLN-773)

Read `<CR_DIR>/review_result.json` → `stats.verification` and `stats.justification`. Render the footer below verbose-by-design — operators read the per-reviewer FP rate and the justification rate to detect over-rejection (reviewer hallucinating) and escape-hatch abuse (authors gaming the gate) respectively.

```
=== Verifier Stats ===
Findings verified: {stats.verification.verified_count}
  - CONFIRMED + DOWNGRADE: {verified_count - tentative_count - re_asserted}
  - TENTATIVE:             {tentative_count}
  - RE_ASSERTED:           sum over by_reviewer[].re_asserted
Findings dismissed: {stats.verification.rejected_count}
Findings justified: {stats.justification.justified_emitted}
  - JUSTIFIED-VALID:   {stats.justification.justified_valid}
  - JUSTIFIED-INVALID: {stats.justification.justified_invalid}
Reviewers (FP rate / overrides):
  {reviewer}: {fp_rate:.2f} / {re_asserted}{ "  ⚠ override" if re_asserted > 0 else "" }
Justification rate: {stats.justification.rate:.2f} (threshold {threshold} — {ALERT|OK})
Premise MEDIUM cumulative: {stats.premise_cumulative_medium_count} (gate threshold {premise_cumulative_medium})
```

If the verify-prepare manifest carried `no_verify: true` (read `<CR_DIR>/verify_manifest.json`), prepend the audit banner BEFORE the Verifier Stats section:

```
⚠️ --no-verify was passed; finding verification was bypassed entirely.
   Reason: "{no_verify_reason}"
   {N} findings reached verdict without verifier audit.
```

If the verify-prepare manifest carried `override_hits` (operator `--re-assert` honored) or `override_invalidated` (override rejected on file-content drift), echo a one-line summary:

```
ℹ️ Overrides: {len(override_hits)} honored / {len(override_invalidated)} invalidated (content drift).
```

### Operator flags affecting the presenter (PLN-773)

- **`--justified-only`** — when present, render ONLY the Justified Findings section above. Suppress BLOCKING / HIGH / MEDIUM / Dismissed sections so the operator can audit justification usage without scrolling past every finding.
- **`--re-assert <id>[,<id>...]`** — write operator overrides for the listed finding IDs via `code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids <ids> [--reason '<why>']`. Promotes from `rejected[]` / `pending_verification[]` back into `verified[]` on the next run. Persists across runs via `<CACHE_DIR>/overrides/<finding_id>.json` keyed on file-content hash — content drift auto-invalidates the override.
- **`--review-dismissed`** — fetch a second opinion (haiku verifier) on prior `rejected[]`. Run `review-dismissed-prepare` to build the manifest, dispatch a haiku-verifier fleet against the per-finding inputs, then run `review-dismissed-consolidate` to auto-promote any non-REJECTED verdict via the same override file format (`override: "REVIEW_DISMISSED"`). Side-by-side diff lands at `<CR_DIR>/review_dismissed_diff.json`.
- **`--no-verify`** — emergency bypass. **Requires `--no-verify-reason='<why>'`** so the bypass is captured in the audit log. The verifier is skipped entirely; every eligible finding lands in `verified[]` with `verifier_verdict: null`. Mutually exclusive with `--re-assert` / `--review-dismissed`.

### Mutual exclusion enforcement

The orchestrator MUST reject `--no-verify` combined with `--re-assert` or `--review-dismissed` at flag-parse time with a clear error message — emergency bypass is an explicit operator decision; combining it with overrides muddles the audit trail. `cmd_verify_prepare`'s own `--no-verify-reason` check is the second line of defense.

### Override precedence in stage_22b

When `cmd_verify_prepare` runs with a `--cache-dir`, the precedence is:

1. **`<CACHE_DIR>/overrides/<finding_id>.json`** — operator override. If the file exists and the cited file's content hash still matches, synthesize a `RE_ASSERTED` verdict and skip both the verifications/ cache and the agent spawn.
2. **`<CACHE_DIR>/verifications/<finding_id>.json`** — cached verifier verdict for the `(finding_id, snippet_hash, model, prompt_hash)` tuple. Materialize at the canonical output path and skip the agent spawn.
3. **Agent spawn** — fall through; the orchestrator dispatches a verifier agent for this finding.

Hash drift on an override (file content changed since the override was written) → override invalidated silently (logged in `manifest.override_invalidated[]`); verifier runs normally.

---

## Validation Summary

- **Total findings from agents:** X
- **Hygiene findings:** H
- **Validated (confirmed):** A
- **Discarded — file not changed:** B
- **Discarded — line not changed:** C
- **Discarded — low confidence:** D
- **Discarded — rejected by validation:** E
- **Duplicates merged:** F
- **Cross-file grouped:** G (findings with `other_locations`)
- **Downgraded to MEDIUM:** H

### Discarded Findings
[List discarded findings grouped by discard reason — helps track agent accuracy]

---

## Summary

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

**Recommendation:** [action based on findings]
```

**Consolidated Finding Format** (when multiple findings share root cause):

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]

**Other Locations** (N more):
- `path/file.ts:87` — same pattern in `functionName()`
- `path/file.ts:124` — same pattern in `otherFunction()`

**Recommendation:** [fix]
```

Mark todo as `completed`.
