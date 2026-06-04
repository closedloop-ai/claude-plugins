# GitHub Mode: Constraints and Output Steps

## Allowed Actions (read-only review + file-based handoff)

These constraints apply ONLY when `MODE=github`. Local mode has no restrictions.

- ✅ READ files and analyze the PR diff
- ✅ Write validated findings to `.closedloop-ai/code-review-findings.json` (workflow posts inline comments)
- ✅ Write outdated thread IDs to `.closedloop-ai/code-review-threads.json` (workflow resolves threads)
- ✅ Write review summary to `.closedloop-ai/code-review-summary.md` (workflow handles posting)
- ✅ Write temp files to `<CR_DIR>/*` (session directory created during setup)
- ❌ Do NOT use compound Bash commands — no `&&`, `||`, `;`, or `|` pipes. Each Bash call must be a single simple command. CI permissions deny compound commands by design.
- ❌ Do NOT checkout, switch branches, or modify any code
- ❌ Do NOT create, edit, or modify any files in the repository (except `.closedloop-ai/code-review-summary.md`, `.closedloop-ai/code-review-findings.json`, `.closedloop-ai/code-review-threads.json`, and `$CR_DIR/*`)
- ❌ Do NOT call `resolveReviewThread` mutations directly
- ❌ Do NOT use `mcp__github_inline_comment__create_inline_comment` — write findings to file instead
- ❌ Do NOT merge, close, approve, or request changes on the PR

---

## PR Metadata Resolution

**Skip this section entirely if MODE=local.**

**With explicit PR number** (preferred — always works, including detached HEAD in CI):
```bash
gh pr view <PR_NUMBER> --json number,headRefOid,baseRefName,headRefName -q '{number: .number, headRefOid: .headRefOid, baseRefName: .baseRefName, headRefName: .headRefName}'
```

**Without PR number — auto-detect** (fails in detached HEAD / CI):
```bash
gh pr view --json number,headRefOid,baseRefName,headRefName -q '{number: .number, headRefOid: .headRefOid, baseRefName: .baseRefName, headRefName: .headRefName}'
```

**Detached HEAD fallback** (CI environments like GitHub Actions checkout a commit SHA, not a branch):
If `gh pr view` fails with "not on any branch", extract the PR number from the GitHub Actions event payload:
```bash
# Extract PR number from GitHub event payload (available in CI)
PR_NUMBER=$(python3 -c "import json; print(json.load(open('$GITHUB_EVENT_PATH'))['pull_request']['number'])" 2>/dev/null)
# Then use explicit PR number form above
```
If `GITHUB_EVENT_PATH` is not set (not in CI), fall back to listing open PRs and matching by HEAD SHA:
```bash
HEAD_SHA=$(git rev-parse HEAD)
PR_NUMBER=$(gh pr list --state open --json number,headRefOid -q ".[] | select(.headRefOid == \"$HEAD_SHA\") | .number")
```

```bash
# Get repo info
gh repo view --json nameWithOwner -q .nameWithOwner
```

Extract and store:
- **PR_NUMBER**: The PR number
- **HEAD_SHA**: The `headRefOid` (commit ID for inline comments)
- **BASE_REF**: PR base branch (`baseRefName`) unless overridden by `--base <ref>`
- **HEAD_REF**: PR head branch (`headRefName`)
- **OWNER**: First part of nameWithOwner before `/`
- **REPO_NAME**: Second part of nameWithOwner after `/`

Set diff scope for GitHub auto-detect runs (when Step 2 did not already set `DIFF_SCOPE`):
```bash
# Respect explicit --base override if present
if [ -n "$BASE_REF_OVERRIDE" ]; then
  BASE_REF="$BASE_REF_OVERRIDE"
fi

# Ensure remote head ref exists locally for diffing
git fetch origin "$HEAD_REF" 2>/dev/null || true

# Only set this if DIFF_SCOPE is still empty (auto-detect path)
# Never rewrite an explicit PR scope from Step 2.
if [ -z "$DIFF_SCOPE" ]; then
  DIFF_SCOPE="origin/${BASE_REF}...origin/${HEAD_REF}"
fi

# Keep DIFF_TIP aligned for downstream context-key/cache logic
DIFF_TIP="origin/${HEAD_REF}"
```

**Important:** In GitHub mode, do NOT set `DIFF_SCOPE` to `origin/<base>...HEAD`.
Always use the PR head ref (`origin/<headRefName>`) so detached HEAD checkouts and
cross-branch reviews diff the correct commits.

Write PR metadata to disk for Steps 6-8 using the Write tool (NOT Bash) — write to `<CR_DIR>/github_pr.json`:
```json
{
  "pr_number": <PR_NUMBER>,
  "head_sha": "<HEAD_SHA>",
  "owner": "<OWNER>",
  "repo_name": "<REPO_NAME>"
}
```

---

## Step 6: Write Findings and Thread Data to Files

Mark todo "Write findings and thread data to files" as `in_progress`.

Read PR metadata from disk using the Read tool on `<CR_DIR>/github_pr.json`.
Extract `PR_NUMBER`, `HEAD_SHA`, `OWNER`, `REPO_NAME`.

### 6a: Identify Outdated Threads

Query existing review threads (LLM judgment retained for deciding what's outdated):

```bash
gh api graphql -f query='
query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first:10) {
            nodes {
              id
              body
              author { login }
            }
          }
        }
      }
    }
  }
}' -f owner="<OWNER>" -f name="<REPO_NAME>" -F number=<PR_NUMBER> -f cursor=""
```

Paginate until `pageInfo.hasNextPage` is false. Accumulate all `nodes` across pages
before deciding which threads are outdated. Do not stop at the first 100 threads.

For each unresolved thread authored by a review bot (`closedloop-cl`, `closedloop-ai[bot]`, or `closedloop-ai-stage[bot]`):
- Check if `isResolved` is true: SKIP
- Read current state of file/line (use `git diff` or Read tool)
- If issue is FIXED or line no longer exists: collect its thread ID

Write `.closedloop-ai/code-review-threads.json`:
```json
{"schema_version": 1, "pr_number": 123, "outdated_thread_ids": ["PRRT_...", "PRRT_..."]}
```

If no threads are outdated, write with an empty array — the workflow step handles this gracefully.

### 6b: Write Validated Findings

Read `$CR_DIR/review_result.json` when present (PLN-722), else fall back to `$CR_DIR/validate_output.json`.

Write `.closedloop-ai/code-review-findings.json`:
```json
{"schema_version": 1, "pr_number": 123, "head_sha": "abc123...", "findings": [...]}
```

The `findings` array contains the envelope's `verified[]` only (NOT `rejected[]`, `justified[]`, or `pending_verification[]` — those have separate files; see 6c and 6d). When no envelope exists (verifier disabled / shadow mode), fall back to the legacy validate output. The workflow's `post-comments` step handles formatting, dedup against existing comments, and error handling.

### 6c: Write Dismissed and Pending Findings (PLN-722)

Read `$CR_DIR/review_result.json` (the canonical envelope). If absent, skip this step entirely — the run pre-dates PLN-722 or `stage_24a_verify_consolidate` did not produce output, and the dismissed-findings UX is meaningless without verifier verdicts.

Write `.closedloop-ai/code-review-dismissed.json` with the verifier-dismissed findings (the workflow posts these as a separate "ℹ️ N findings dismissed" PR comment with collapsible `<details>` blocks per finding):

```json
{
  "schema_version": 1,
  "pr_number": 123,
  "head_sha": "abc123...",
  "dismissed": [...envelope.rejected...],
  "pending": [...envelope.pending_verification...],
  "force_human_review": false
}
```

Write `.closedloop-ai/code-review-dismissed-summary.md` with a human-readable rendering. Skip the entire file when both `dismissed` and `pending` are empty:

```markdown
## Verifier Dismissals

ℹ️ {N} finding(s) emitted by reviewers were disproved by the verifier with cited evidence. They are NOT included in the inline comments above. If you disagree with a dismissal, see the full evidence chain in `review_result.json.rejected[]`.

<details>
<summary>{ORIGINAL_SEVERITY} dismissed: {FILE}:{LINE} — {ISSUE_HEAD}</summary>

**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Verifier verdict:** REJECTED ({REJECTION_CLASS})
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original issue:** {ISSUE}

**Verifier reasoning:** {VERIFIER_REASONING}

**Evidence checks:**
- ✓/✗ {claim} — {actual_read} ({source})

</details>

<!-- repeat per dismissed -->

## Pending Verification

⚠️ {M} finding(s) were eligible for verification but no verifier output landed on disk (agent timeout or budget overflow). Treat them as unverified.

- `{FILE}:{LINE}` — {ISSUE_HEAD} (id: `{ID}`)
```

If `envelope.force_human_review == true`, prepend a banner to `code-review-dismissed-summary.md`:

```markdown
> 🚨 **Mandatory human review path touched.** One or more findings landed on a path configured in `verification-gates.json` → `mandatory_human_review_paths`. The verifier escalated them to TENTATIVE and the verdict is forced to `NEEDS_ATTENTION` regardless of severity.
```

### 6d: Write Justified Findings (PLN-721)

Read `$CR_DIR/review_result.json` → `justified[]`. If absent or empty, skip this step — there are no justified findings to surface and the file is meaningless. Otherwise write `.closedloop-ai/code-review-justified.json` (the workflow posts these as a separate "ℹ️ N findings justified by author" PR comment with collapsible `<details>` blocks per finding):

```json
{
  "schema_version": 1,
  "pr_number": 123,
  "head_sha": "abc123...",
  "justified": [...envelope.justified...]
}
```

Also write `.closedloop-ai/code-review-justified-summary.md` (skip when `justified[]` is empty):

```markdown
## Author-Justified Findings

ℹ️ {N} finding(s) were emitted by reviewers but absorbed by author justification comments the verifier independently validated. They are NOT included in the inline comments above. If you disagree with a dismissal, see the full chain in `review_result.json.justified[]`.

<details>
<summary>{ORIGINAL_SEVERITY} justified: {FILE}:{LINE} — {ISSUE_HEAD}</summary>

**Finding ID:** `{ID}`
**Original reviewer:** {REVIEWER}
**Subcategory:** `{SUBCATEGORY}` (Premise findings only)
**Verifier verdict:** JUSTIFIED-VALID
**Verifier confidence:** {VERIFIER_CONFIDENCE}

**Original concern:** {ISSUE}

**Author's justification:**
> {JUSTIFICATION_TEXT}
>
> — cited at `{JUSTIFICATION_SOURCE}` by `{CLAIMED_BY_REVIEWER}`

**Verifier reasoning:** {VERIFIER_REASONING}

</details>

<!-- repeat per justified -->
```

Mark todo as `completed`.

### 6e: Write Verifier Stats (PLN-773)

Read `$CR_DIR/review_result.json` → `stats.verification` and `stats.justification`. If neither block is present (very old envelope), skip this step. Otherwise write `.closedloop-ai/code-review-verifier-stats.md` (the workflow posts this as a collapsible `<details>` block in a single comment so the metrics are visible to PR reviewers without polluting inline review comments):

```markdown
## Verifier Stats

<details>
<summary>{verified_count} verified · {rejected_count} dismissed · {justified_emitted} justified</summary>

**Verifier outcomes**
- CONFIRMED + DOWNGRADE: {verified_count - tentative_count - re_asserted}
- TENTATIVE: {tentative_count}
- RE_ASSERTED: {sum over by_reviewer[].re_asserted}
- REJECTED: {rejected_count}

**Justification (PLN-721 escape hatch)**
- Justified emitted: {justified_emitted} ({rate:.0%} of Premise total)
- JUSTIFIED-VALID: {justified_valid}
- JUSTIFIED-INVALID: {justified_invalid} (rejection rate {rejection_rate:.0%})
- Threshold alert: {threshold_alert} (alerts when rate > {justification_rate_alert:.0%})

**Per-reviewer FP rate** (rejected / audited)
| Reviewer | Verified | Rejected | FP rate | Re-asserts |
|---|---|---|---|---|
| {reviewer} | {verified} | {rejected} | {fp_rate:.2f} | {re_asserted} {"⚠" if re_asserted > 0 else ""} |

The Reviewer column keys off the `reviewer` field, which `cmd_collect_findings` derives from the agent filename (`agent_bha_p0.json` → `reviewer='bha_p0'`). Under partitioned mode the table shows one BHA row per partition (`bha_p0`, `bha_p1`, …); under unified mode it shows a single `bha_p0` row because only one partition exists.

**Premise MEDIUM cumulative gate**
- Current count: {premise_cumulative_medium_count}
- Gate threshold: {premise_cumulative_medium}

**Partition mode** ({verify_manifest.partition_mode}, {verify_manifest.partition_count} partitions) — read from `<CR_DIR>/verify_manifest.json`. Omit this line when the manifest file is absent (hygiene-only run or pre-PLN-774 cache).

</details>
```

If the manifest carries `override_hits` or `override_invalidated`, append a one-liner inside the `<details>` block:

```
ℹ️ Operator overrides: {len(override_hits)} honored, {len(override_invalidated)} invalidated by file-content drift.
```

Mark todo as `completed`.

---

## Step 8: Write Summary

Mark todo "Write summary to .closedloop-ai/code-review-summary.md" as `in_progress`.

**CRITICAL**: This step is MANDATORY, even if there are no findings.

### Determine Status Label (for summary only)

Based on validated findings, set status label for the summary comment:
- **BLOCKING findings > 0**: "Changes Requested" (label only)
- **HIGH findings > 0 + no BLOCKING**: "Needs Attention" (label only)
- **MEDIUM only or no findings**: "Approved" (label only)

**IMPORTANT**: These are LABELS for the summary comment only. Do NOT use `--approve` or `--request-changes` flags.

### Write Summary to File

Write the summary to `.closedloop-ai/code-review-summary.md`. The CI workflow will handle marking old summaries as outdated and posting the new one deterministically.

```bash
# Write the summary content to the file
cat > .closedloop-ai/code-review-summary.md << 'SUMMARY_EOF'
<summary content here>
SUMMARY_EOF
```


**Do NOT** post the summary to GitHub directly. Do NOT use `gh api` to create comments or `gh pr review` to submit a review. The workflow handles all GitHub posting after Claude exits.

### Summary Format

```markdown
## Code Review Summary

**Status:** [Approved | Changes Requested | Needs Attention]
```

**Reviewer Fleet block (PLN-725 Phase 9 / v2.23.0).** Do NOT hand-author the Reviewers / Model Routing lines. Run the canonical renderer and embed its output verbatim immediately after the **Status** line:

```bash
python "${CLAUDE_PLUGIN_ROOT}/tools/python/code_review_helpers.py" render-fleet-summary --cr-dir <CR_DIR>
```

The renderer reads `<CR_DIR>/spawn.json` (sections: `spec` — intended fleet from stage_19b; `verification` — runtime tally from stage_20b; `route` — model assignments from Gate B) and emits the **Reviewers**, **Model Routing**, **Fleet** (`N intended | N ran | N required missing`), and a conditional **Notes** block. The notes surface non-default outcomes (BLOCKING sanitization, runtime missing required, BHA budget cap, PLN-723 deferral, malformed-plan required skips) — operators reading the summary comment see these without having to dig into `coverage_gaps.json` or `spawn.json.verification`.

**Fallback:** if the renderer reports `spawn-spec unavailable` or `spawn-spec fell back`, embed its line as-is — the orchestrator walked the static fleet for this run and the static `## Reviewer Fleet` section of `start.md` is the source of truth for fleet composition.

**Fast-path runs** are handled by the renderer — it emits the `Fast Path Reviewer (single-agent mode)` line + the resolved fast-path model. No branch needed in this presenter.

Then continue with the remaining summary content:

```markdown
### Findings

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

### BLOCKING Issues (must fix)
1. **[P0] [file:line]** Title

### HIGH Issues (should fix)
1. **[P1] [file:line]** Title

### MEDIUM Issues (consider)
1. **[P2] [file:line]** Title
2. **[P3] [file:line]** Title

### Validation Stats

Mirrors the local-mode Validation Summary so PR reviewers can see the same accuracy-audit signal (which reviewer discarded how many findings for what reason) without having to read local logs. Read `<CR_DIR>/findings_validated.json` for the discard-reason counts; an absent file means a pre-PLN-722 run — emit only the two lines marked **(always)** below and skip the rest.

- **Total findings from agents:** X
- **Validated (confirmed):** A
- **Discarded — file not changed:** B
- **Discarded — line not changed:** C
- **Discarded — low confidence:** D
- **Discarded — rejected by validation:** E
- **Duplicates merged:** F
- **Cross-file grouped:** G *(always — `other_locations` count)*
- **Downgraded to MEDIUM:** I
- **Hygiene findings:** H
- **Agent failures:** N partitions skipped *(always — even when findings_validated.json absent)*

(Placeholder `I` is intentional — `H` is reserved for "Hygiene findings." Reusing `H` would conflate two distinct counts.)

**Recommendation:** [Approve | Address blocking/high issues | Consider medium items]
```

Include **summary-only findings** (those with `"inline": false`) in the appropriate severity section — these don't have inline comments but should still be visible in the summary.

If `normalization_warnings > 0`, append after the findings table:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

**Summary constraints:**
- Keep it CONCISE (max 500 words) — no multi-paragraph explanations or lengthy prose
- Do NOT repeat what inline comments already say — just reference file:line
- Focus on actionable findings only
- **NO FOOTER**: Do NOT add any signature, attribution, or footer like "Automated review by Claude Code"

Mark todo as `completed`.
