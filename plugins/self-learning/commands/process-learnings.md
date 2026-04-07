---
description: Process pending learnings from a ClosedLoop run into org-patterns.toon
argument-hint: [working-directory]
skills: self-learning:toon-format
---

# Process Learnings Command

<context>
This command processes learnings captured during ClosedLoop runs and merges them into the global organization knowledge base. Learnings accumulate across all runs and projects, enabling continuous improvement of agent behavior.

**Purpose:** Transform raw pending learnings into validated, deduplicated patterns stored in `~/.closedloop-ai/learnings/org-patterns.toon`.

**Success criteria:**
- All pending learnings are classified and processed
- Learnings are validated for correctness and clarity (misleading patterns rejected or reworded)
- Duplicates are merged (not created separately)
- Global org-patterns.toon is updated with new/updated patterns
- Processed files are cleaned up
</context>

## Usage

```
/process-learnings [workdir]
```

- `workdir`: Path to the ClosedLoop run directory (defaults to current directory)

## Instructions

Execute these steps in order:

### Step 1: Determine Working Directory

Parse the argument to identify CLOSEDLOOP_WORKDIR:

1. If argument provided → use it as `CLOSEDLOOP_WORKDIR`
2. Else if `.learnings/pending/` exists in current directory → use current directory
3. Else check `.closedloop-ai/runs/*/` for recent runs with pending learnings

### Step 1.5: Rescue Stray Learnings from Project Root

Subagents sometimes write learnings to the project root `.learnings/pending/` instead of `$CLOSEDLOOP_WORKDIR/.learnings/pending/`. Check for and move any stray files:

```bash
PROJECT_ROOT=$(git -C "$CLOSEDLOOP_WORKDIR" rev-parse --show-toplevel 2>/dev/null)
if [[ -n "$PROJECT_ROOT" ]] && [[ -d "$PROJECT_ROOT/.learnings/pending" ]]; then
    STRAY_FILES=$(ls -A "$PROJECT_ROOT/.learnings/pending/"*.json 2>/dev/null)
    if [[ -n "$STRAY_FILES" ]]; then
        echo "Found stray learnings at project root, moving to $CLOSEDLOOP_WORKDIR/.learnings/pending/"
        mkdir -p "$CLOSEDLOOP_WORKDIR/.learnings/pending"
        mv "$PROJECT_ROOT/.learnings/pending/"*.json "$CLOSEDLOOP_WORKDIR/.learnings/pending/"
    fi
fi
```

### Step 2: Validate Pending Learnings Exist

```bash
PENDING_DIR="$CLOSEDLOOP_WORKDIR/.learnings/pending"
if [[ ! -d "$PENDING_DIR" ]] || [[ -z "$(ls -A "$PENDING_DIR" 2>/dev/null)" ]]; then
    echo "No pending learnings found in $PENDING_DIR"
    exit 0
fi
```

List the pending files for the user:
```bash
echo "Found pending learnings:"
ls -la "$PENDING_DIR"/*.json 2>/dev/null
```

### Step 3: Classify Pending Learnings

Spawn the `learning-capture` agent with environment:
- `CLOSEDLOOP_WORKDIR` = the workdir
- `CLOSEDLOOP_RUN_ID` = extracted from workdir path or generated
- `CLOSEDLOOP_ITERATION` = current timestamp

The agent classifies each pending learning:

| Field | Values |
|-------|--------|
| scope | `closedloop` (tool/framework) or `organization` (project-specific) |
| category | `mistake`, `pattern`, `convention`, `insight` |
| repo_scope | `*` (generalizable across repos) or repo-specific (e.g., `astoria-frontend`) |

**Classification guidance for `repo_scope`:**
- `*` = applies to any project using the same language/framework/tool (no references to project-specific files, components, or conventions)
- repo-specific = mentions file paths, component names, API routes, config keys, or conventions unique to a codebase. Derive repo name from `git remote get-url origin` (basename without .git), falling back to `basename $(cd "$(git rev-parse --git-common-dir)/.." && pwd)` (handles worktrees correctly)

**Output:** `sessions/run-{RUN_ID}/iter-{N}.json`
**Cleanup:** Delete processed files from `pending/`

### Step 3.5: Validate and Reword Learnings

**Create a task list to track validation:**

```
TaskCreate: "Validate learnings for factual accuracy"
TaskCreate: "Check repo_scope correctness (* vs repo-specific)"
TaskCreate: "Reword unclear or misleading learnings"
TaskCreate: "Output validation summary"
```

Before aggregation, the orchestrator must vet each learning for correctness and clarity. Agent-generated learnings often contain:
- **Overgeneralizations**: Project-specific patterns stated as universal truths
- **Misleading implications**: Wording that suggests things that aren't true
- **Incorrect facts**: Misunderstandings about tools, APIs, or conventions
- **Scope errors**: Global patterns that reference project-specific details

**For each classified learning, evaluate:**

| Check | Question | Action if fails |
|-------|----------|-----------------|
| **Factual accuracy** | Is this statement true? Does it match actual tool/API behavior? | Reject or correct |
| **Scope correctness** | Does a `repo_scope: *` pattern reference project-specific URLs, paths, or conventions? | Set `repo_scope` to specific repo name, or reject |
| **Clarity** | Could this be misinterpreted? Does it imply things not explicitly stated? | Reword for precision |
| **Generalizability** | Is this actually useful across projects, or is it a one-off observation? | Set `repo_scope` to specific repo if not generalizable |
| **Conciseness** | Is it a single sentence with no code blocks or inline code? | Reword to remove code, keep only the principle |

**Common patterns to catch:**

1. **False universals**: "All X must use Y" when only this project uses Y
   - Example: "Claude CLI plugin marketplace registration must use GitHub repo URL" → This is project-specific, not a universal requirement

2. **Implied exclusivity**: Wording that suggests there's only one way/place/tool
   - Example: "the GitHub repo URL" → implies only one valid URL exists

3. **Project URLs/paths as patterns**: Specific URLs, paths, or identifiers treated as universal conventions
   - Example: `https://github.com/closedloop-ai/claude_code.git` is not a universal pattern, it's this repo's URL → set `repo_scope` to repo name
   - Example: "Check apps/app/lib/constants.ts" → set `repo_scope` to repo name (not `*`)

4. **Configuration values as patterns**: Project-specific commands or settings stated as universal
   - Example: "Run `pnpm test` for validation" → set `repo_scope` to repo name, or reject if too trivial
   - Example: "Use ProjectArtifactType not ArtifactType" → set `repo_scope` to repo name

5. **Embedded code**: Inline code or code blocks used as the learning itself rather than describing a principle
   - Example: `` Use `{ path: ['key'], equals: value }` for JSON filters `` → "Prisma JSON field filters require path-based syntax, not dot notation"

**Note:** Do NOT reject learnings just because they seem like "basic knowledge" to humans. These learnings exist because an LLM agent actually made that mistake and corrected it. Even TypeScript basics or git fundamentals are valid if agents keep stumbling on them.

**Reword or reject:**

```
BEFORE (problematic):
"Claude CLI plugin marketplace registration in GitHub Actions must use the GitHub repo URL"

AFTER (corrected - repo-scoped):
"CI installs Claude plugins via the repo's GitHub URL" (repo_scope: claude_code)

OR if truly not useful even repo-scoped, REJECT with reason:
"Learning is a one-off CI config detail, not a reusable pattern"
```

**Output:** Update `sessions/run-{RUN_ID}/iter-{N}.json` with validated/reworded learnings, adding a `validation` field:
```json
{
  "validation": {
    "status": "approved" | "reworded" | "rejected",
    "original_summary": "...",  // if reworded
    "reason": "..."  // if rejected
  }
}
```

**Display validation summary to user:**
```
Validation Results:
- Approved: X learnings (W global, V repo-scoped)
- Reworded: Y learnings (generalized or clarified)
- Scoped to repo: S learnings (were marked global, narrowed to specific repo)
- Rejected: Z learnings

Rejected learnings:
  1. "Original summary..." - Reason: one-off config detail, not a reusable pattern
  2. "Original summary..." - Reason: too trivial to be useful
  ...

Scoped to repo:
  1. "Check apps/app/lib/constants.ts..." - references project-specific path → repo: astoria-frontend
  2. "Use ProjectArtifactType for frontend types" → repo: astoria-frontend

Reworded learnings:
  1. BEFORE: "Use ProjectArtifactType for frontend types"
     AFTER:  "Frontend and backend may use different enum names for the same concept - check both layers"
```

Mark all validation tasks as completed before proceeding.

### Step 4: Aggregate Patterns into merge-result.json

After classification, merge **all validated** patterns into a JSON file that a deterministic Python script will convert to TOON format:

1. **Load existing** - Read `~/.closedloop-ai/learnings/org-patterns.toon` (if exists)
2. **Read session files** - Scan `sessions/run-*/iter-*.json` from the run
3. **Filter** - Only include learnings with `validation.status != "rejected"`
4. **Deduplicate** - See [Deduplication Rules](#deduplication-rules)
5. **Prune low-performers** - Flag or remove patterns with poor track records:
   - `success_rate < 0.20` AND `seen_count >= 5` → Add `[PRUNE]` flag
   - `success_rate == 0.00` AND `seen_count >= 10` → Remove entirely (confirmed unhelpful)
   - Report pruned patterns to user for awareness
6. **Skip success rate calculation** - Success rates are computed deterministically by
   `compute_success_rates.py` after this step. Do NOT calculate success_rate, confidence,
   or flags from outcomes.log. For new patterns set success_rate empty, confidence medium,
   flags [UNTESTED]. Preserve existing values for updated patterns.
7. **Set repo field** - Use the `repo_scope` from classification:
   - `*` → pattern is generalizable across repos
   - repo-specific → use the classified repo name
8. **Extract closedloop learnings** → append to `pending-closedloop.json`
9. **Limit patterns** - Cap at 50 to prevent context bloat. When at cap, trim by staleness only:
   - Drop `[PRUNE]` flagged patterns first, then `[STALE]`, then `[REVIEW]`
   - Never trim by confidence — low-confidence patterns need exposure to earn higher confidence
   - Among patterns with the same flag tier, prefer keeping higher `seen_count` (more observed)
10. **Write output** - Save to `$CLOSEDLOOP_WORKDIR/.learnings/merge-result.json` with the following schema:

```json
{
  "schema_version": "1.0",
  "generated_at": "ISO8601 timestamp",
  "stats": { "added": N, "merged": N, "pruned": N, "rejected": N, "closedloop_extracted": N },
  "patterns": [
    { "id": "P-NNN", "category": "pattern", "summary": "plain text (no CSV quoting)",
      "confidence": "high", "seen_count": "5", "success_rate": "0.85", "flags": "",
      "applies_to": "*", "context": "auth|API", "repo": "*" }
  ]
}
```

All 10 fields are required per pattern. `summary` is plain text — the Python script handles CSV quoting. `success_rate` is `""` for new patterns; preserve existing values for updated patterns.

**Do NOT write TOON directly** — the shell caller runs `write_merged_patterns.py` to convert this JSON to valid TOON atomically.

**Do NOT clean up session files** — cleanup is owned by the shell callers, gated on Python script success.

### Step 5: Report Results

Output a summary to the user:

```
Processed X learnings:
- Y patterns added/updated (W global, V repo-scoped)
- Z closedloop learnings extracted
- R patterns rejected

Repo breakdown:
  - * (global): W patterns
  - astoria-frontend: V patterns
  - claude_code: U patterns

Pruning (existing patterns):
- A patterns flagged [PRUNE] (success_rate < 20% over 5+ observations)
- B patterns removed (0% success rate over 10+ observations)

Current org-patterns.toon: N patterns (cap: 50)

Updated: ~/.closedloop-ai/learnings/org-patterns.toon
```

## Examples

```bash
# Process learnings from a specific run
/process-learnings /Users/user/Source/project/.closedloop-ai/runs/new-feature

# Process learnings from current directory
/process-learnings
```

---

## Reference

### Output Files

<output_files>
**Run-specific (`$CLOSEDLOOP_WORKDIR/.learnings/`):**
- `sessions/run-{ID}/iter-{N}.json` - Classified learnings (temporary, deleted after aggregation)
- Processed pending files are deleted after classification
- `pending-closedloop.json` - ClosedLoop-specific learnings for export

**Global:**
- `~/.closedloop-ai/learnings/org-patterns.toon` - Merged organization knowledge base (accumulates across all runs)
</output_files>

### TOON Output Format

```toon
# Organization Patterns (TOON format)
# Last updated: 2024-01-15T10:30:00Z

patterns[2]{id,category,summary,confidence,seen_count,success_rate,flags,applies_to,context,repo}:
  P-001,pattern,"Always check token expiry before API calls",high,5,0.85,,implementation-subagent,auth|API,*
  P-002,mistake,"Check for None before accessing optional dict keys",medium,3,0.60,[REVIEW],*,python|safety,astoria-frontend
```

See the `self-learning:toon-format` skill for complete syntax rules and quoting conventions.

### Deduplication Rules

Patterns are deduplicated before merging:

| Condition | Action |
|-----------|--------|
| Exact match on `trigger` | Skip (already exists) |
| 80%+ word overlap on `summary` | Merge (increment `seen_count`) |
| Otherwise | Add as new pattern |

```python
def is_duplicate(existing, new):
    if existing.trigger == new.trigger:
        return True  # Exact match
    similarity = len(set(existing.summary.split()) & set(new.summary.split())) / \
                 len(set(existing.summary.split()) | set(new.summary.split()))
    return similarity >= 0.80  # 80% overlap

def merge_patterns(existing, new):
    existing.seen_count += 1
    existing.confidence = recalculate_confidence(existing)
```

### Success Rate Calculation

Success rates are now computed **deterministically** by `compute_success_rates.py` (runs as Step 8 in the post-iteration pipeline). This command should NOT calculate success rates itself.

The Python script handles:
1. Matching outcomes to patterns by trigger text (tiered: exact → case-insensitive → substring → Jaccard > 0.6)
2. Computing per-pattern: `success_rate = (applied without |unverified) / total`
3. Goal-weighted mode: `goal_success=1` → full weight; `goal_success=0` → `relevance × 0.5`
4. Updating confidence and flags based on computed rates
