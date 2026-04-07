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

Read `$CR_DIR/validate_output.json`, extract the `validated` array.

Write `.closedloop-ai/code-review-findings.json`:
```json
{"schema_version": 1, "pr_number": 123, "head_sha": "abc123...", "findings": [...]}
```

The findings use the same format as the validate output. The workflow's `post-comments` step handles formatting, dedup against existing comments, and error handling.

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

Read `<CR_DIR>/route.json` before rendering. Extract `fast_path`, `models["fast_path_reviewer"]`, and `domain_critics`.

```markdown
## Code Review Summary

**Status:** [Approved | Changes Requested | Needs Attention]
```

**Reviewers line is conditional on `fast_path`:**

- **If `fast_path == true`:**
```markdown
**Reviewers:** Fast Path Reviewer (single-agent mode)
**Model Routing:** Fast path — <MODEL> single reviewer
```

- **If `fast_path == false`:**
```markdown
**Reviewers:** Bug Hunter A, Bug Hunter B, Unified Auditor, Premise Reviewer
[+ domain specialist if triggered]
```

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

- **Agent failures:** N partitions skipped
- **Cross-file grouped:** M findings consolidated

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
