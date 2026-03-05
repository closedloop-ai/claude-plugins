---
name: artifact-type-tailored-context
description: Compresses artifacts for judge evaluation. Reads a single raw artifact, applies tiered summarization within a token budget, and returns compacted content with metadata. Isolation via forked context prevents pollution of agent context
context: fork
model: haiku
allowed-tools: Read, Bash
---

# Artifact-Type-Tailored Context Skill

## Purpose

Compress individual artifacts within a specified token budget using tiered summarization strategies. This skill operates in isolated forked context to prevent polluting the parent agent's context with large raw artifacts.

## Task Context

You are responsible for compressing a single artifact file to fit within a token budget. Your responsibilities:
1. Read the raw artifact from the specified path
2. Count its tokens using the count_tokens.py script
3. Apply appropriate tiered summarization strategy
4. Return structured JSON with metadata

**Success criteria:**
- Compressed content fits within token budget (or is properly truncated)
- Valid JSON response with all required fields
- Metadata accurately reflects truncation status

---

## Input Parameters

You receive three required parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `artifact_path` | string | Path to artifact file relative to `$CLOSEDLOOP_WORKDIR` |
| `task_description` | string | Compression guidance (e.g., "preserve function signatures") |
| `token_budget` | integer | Maximum allowed tokens for compressed output |

---

## Execution Workflow

### Step 1: Read Artifact

Read the artifact from its absolute path:

```bash
# Construct full path
ARTIFACT_FULL_PATH="$CLOSEDLOOP_WORKDIR/$artifact_path"
```

Use the Read tool to load the artifact content. If the file does not exist, skip to error handling.

### Step 2: Count Raw Tokens

Invoke the count_tokens.py script to get accurate token count:

```bash
cd "$CLOSEDLOOP_WORKDIR" && uv run count_tokens.py "$artifact_path"
```

**Expected output format:**
```json
{
  "input_tokens": 1234
}
```

Parse the JSON output and extract `input_tokens` as `raw_tokens`.

**Error handling:**
- If count_tokens.py fails (exit code non-zero), fallback to character-based heuristic: `raw_tokens = len(content) / 4`
- Add warning to content preamble: `[WARNING: Token count estimated via heuristic due to count_tokens.py failure]\n\n`

### Step 3: Apply Tiered Summarization Strategy

Choose strategy based on raw token count relative to budget:

#### Tier 1: Full Content (raw_tokens <= budget)

**Condition:** `raw_tokens <= token_budget`

**Action:** Return artifact unchanged

**Metadata:**
- `compacted_tokens = raw_tokens`
- `truncated = false`

**No further processing needed.**

---

#### Tier 2: Intelligent Compression (budget < raw_tokens <= budget * 1.5)

**Condition:** `token_budget < raw_tokens <= token_budget * 1.5`

**Action:** Apply artifact-type-specific compression preserving structure

**Compression strategies by artifact type:**

| Artifact Type | Strategy |
|---------------|----------|
| **Code diffs** | Keep function signatures, class declarations, and error messages. Summarize method bodies with `// ... (implementation omitted for brevity)`. Remove comments and blank lines. |
| **JSON files** | Keep all keys and structure. For arrays longer than 10 items, keep first 5 and last 2, replace middle with `{"_truncated": "N items omitted"}`. Truncate string values over 200 chars. |
| **Log files** | Keep all ERROR and WARNING lines. Summarize consecutive INFO lines with `... (N info lines omitted)`. Keep first and last 10 lines intact. |
| **Plan/PRD markdown** | Keep all headings, tables, and code blocks. Summarize paragraph text preserving key nouns and action verbs. Remove redundant examples. |

**Validation:**

After compression, count tokens again:

```bash
cd "$CLOSEDLOOP_WORKDIR" && uv run count_tokens.py <(echo "$compressed_content")
```

**Decision tree:**
- If `compacted_tokens <= token_budget`: Success → Return with `truncated = false`
- If `compacted_tokens > token_budget`: Compression failed → Fallback to Tier 3

---

#### Tier 3: Hard Truncation (raw_tokens > budget * 1.5 OR Tier 2 failed)

**Condition:** `raw_tokens > token_budget * 1.5` OR compression in Tier 2 exceeded budget

**Action:** Hard truncate at character boundary

**Algorithm:**

1. Estimate truncation point: `char_limit = token_budget * 4` (heuristic: 4 chars per token)
2. Find last paragraph boundary (double newline `\n\n`) before `char_limit`
3. Truncate at that boundary
4. Calculate truncated token count: `truncated_tokens = raw_tokens - token_budget`
5. Append truncation marker:

```
[TRUNCATED: content exceeds budget, remaining {truncated_tokens} tokens omitted]
```

**Metadata:**
- `compacted_tokens = token_budget` (approximate)
- `truncated = true`

---

### Step 4: Return JSON Response

Return structured JSON with strict schema:

```json
{
  "artifact_name": "path/to/artifact.ext",
  "raw_tokens": 5000,
  "compacted_tokens": 2000,
  "truncated": false,
  "content": "compressed artifact content here..."
}
```

**Field descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `artifact_name` | string | Original artifact_path parameter |
| `raw_tokens` | integer | Token count from count_tokens.py on raw artifact |
| `compacted_tokens` | integer | Token count after compression (from count_tokens.py validation or estimate for Tier 1/3) |
| `truncated` | boolean | `true` if Tier 3 truncation applied, `false` otherwise |
| `content` | string | Compressed or truncated artifact content |

---

## Error Handling

### Artifact Not Found

**Condition:** `artifact_path` does not exist at `$CLOSEDLOOP_WORKDIR/<artifact_path>`

**Response:**

```json
{
  "artifact_name": "path/to/missing.ext",
  "raw_tokens": 0,
  "compacted_tokens": 0,
  "truncated": true,
  "content": "[ERROR: artifact not found at $CLOSEDLOOP_WORKDIR/path/to/missing.ext]"
}
```

### count_tokens.py Failure

**Condition:** Script exits with non-zero code or returns invalid JSON

**Action:**
1. Fallback to character-based heuristic: `raw_tokens = len(content) / 4`
2. Prepend warning to content:

```
[WARNING: Token count estimated via heuristic due to count_tokens.py failure]

<original content follows>
```

3. Proceed with tiered strategy using estimated token count
4. Set `truncated = false` unless Tier 3 is applied

### Invalid Compression Output

**Condition:** Tier 2 compression produces malformed content (e.g., invalid JSON syntax for JSON artifacts)

**Action:** Immediately fallback to Tier 3 hard truncation with `truncated = true`

---

## Example Scenarios

### Example 1: Small Artifact (Tier 1)

**Input:**
- `artifact_path`: `plan.json`
- `token_budget`: 5000
- Raw tokens: 3200

**Output:**
```json
{
  "artifact_name": "plan.json",
  "raw_tokens": 3200,
  "compacted_tokens": 3200,
  "truncated": false,
  "content": "<full plan.json content>"
}
```

---

### Example 2: Medium Artifact (Tier 2)

**Input:**
- `artifact_path`: `git_diff`
- `token_budget`: 10000
- Raw tokens: 12000 (1.2x budget)

**Compression applied:** Remove comments, summarize method bodies, keep signatures

**Output:**
```json
{
  "artifact_name": "git_diff",
  "raw_tokens": 12000,
  "compacted_tokens": 9500,
  "truncated": false,
  "content": "<compressed diff with function signatures preserved>"
}
```

---

### Example 3: Large Artifact (Tier 3)

**Input:**
- `artifact_path`: `outcomes.log`
- `token_budget`: 3000
- Raw tokens: 25000 (8.3x budget)

**Action:** Hard truncate at ~12000 chars (3000 tokens * 4)

**Output:**
```json
{
  "artifact_name": "outcomes.log",
  "raw_tokens": 25000,
  "compacted_tokens": 3000,
  "truncated": true,
  "content": "<first ~2900 tokens of log>\n\n[TRUNCATED: content exceeds budget, remaining 22000 tokens omitted]"
}
```

---

## Notes

- **Context isolation:** This skill runs in forked context. The raw artifact content does not pollute the parent agent's context.
- **Token counting accuracy:** Always prefer count_tokens.py output over estimates. Only fallback to heuristics on failure.
- **Compression quality:** Tier 2 strategies prioritize structural information (function signatures, keys) over verbose content (comments, redundant text).
- **Budget enforcement:** Tier 3 truncation is a hard stop. Judges must lower confidence when evaluating truncated artifacts.
