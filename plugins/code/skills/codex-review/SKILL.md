---
name: codex-review
description: |
  Run Codex to review a plan file and return structured feedback with a verdict.
  Triggers on: debate loop Codex review rounds.
  Returns VERDICT:APPROVED or VERDICT:NEEDS_CHANGES plus CODEX_SESSION token.
context: fork
allowed-tools: Bash
---

# Codex Review

Call Codex to review an implementation plan and return structured feedback with an approval verdict.

## When to Use

Activated once per debate round in the `/plan-with-codex` command, before Claude revision. The orchestrator calls this skill to get Codex's assessment of the current plan.

## Usage

The `scripts/` directory is relative to this skill's base directory (shown above as "Base directory for this skill").

```bash
bash <base_directory>/scripts/run_codex_review.sh \
  --plan-file <path> \
  --feedback-file <path> \
  --request-file <path> \
  --revisions-file <path> \
  --round <N> \
  --codex-model <model> \
  [--session-id <thread_id>] \
  [--log-id <uuid>]
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--plan-file` | Yes | -- | Absolute path to the implementation plan (plan.json or plan.md) that Codex will review. The script injects this path into the review prompt so Codex can read and analyze the plan's contents. |
| `--feedback-file` | Yes | -- | Absolute path where the script writes Codex's full feedback text (parsed from the JSON stream). The orchestrator reads this file after the script completes to get the detailed findings. This file is overwritten each round. |
| `--request-file` | No | -- | Absolute path to the original user request sidecar. When present and non-empty, the script tells Codex to read it before reviewing the plan so it can judge whether the plan chose the right overall approach for the request, not just whether the plan is internally consistent. If the file begins with `[synthesized]`, Codex is told to treat it as a weak hint rather than authoritative user intent. |
| `--revisions-file` | No | -- | Absolute path to Claude's revision summary from the previous round, listing which findings were accepted and which were rejected with evidence. Only meaningful when round > 1 AND the file exists with actual content (the script checks `-s` for non-empty). The script injects this path into Codex's prompt so it can read the revisions before re-reviewing, but it explicitly tells Codex to verify Claude's rebuttals against the updated plan and codebase rather than trusting the summary blindly. **Omit entirely on round 1 or when no revisions file has been written yet** -- do not pass `/dev/null` or an empty file. |
| `--round` | No | 1 | The current debate round number (1-indexed). Controls the review prompt phase: round 1 runs a broad but material audit, rounds 2-4 run a delta review that first checks whether prior findings were resolved, and rounds 5+ run a blocker-only convergence review. Also gates whether the revisions file is included in the prompt. |
| `--codex-model` | No | gpt-5.3-codex | The OpenAI model ID passed to `codex -m`. Controls which model performs the review. |
| `--session-id` | No | -- | Codex thread ID returned as `CODEX_SESSION` from a previous round. When provided, the script attempts `codex exec resume <session_id>` to continue the conversation with full prior context. If resume fails, it falls back to a fresh session automatically. Omit on round 1. |
| `--log-id` | No | auto-generated UUID | Identifier for the persistent JSONL log file at `~/.closedloop-ai/plan-with-codex/<log-id>.jsonl`. The raw Codex JSON stream is appended here each round. Pass the same ID across all rounds of a debate to keep the full conversation history in one file. If omitted, a new UUID is generated. |

## Interpreting Output

The script prints structured tokens to stdout. Parse these to control the debate loop.

All stdout responses include three tokens: a verdict (or failure indicator), `CODEX_SESSION`, and `LOG_ID`. The raw Codex JSON stream is appended to `~/.closedloop-ai/plan-with-codex/<uuid>.jsonl`. Pass the LOG_ID back via `--log-id` on subsequent rounds to keep all rounds in one log file.

### Approval

```
VERDICT:APPROVED
CODEX_SESSION:abc-123-def
LOG_ID:550e8400-e29b-41d4-a716-446655440000
```

**Action:** Announce approval. Clean up sidecar files. Stop the debate loop.

### Changes Requested

```
VERDICT:NEEDS_CHANGES
CODEX_SESSION:abc-123-def
LOG_ID:550e8400-e29b-41d4-a716-446655440000
```

**Action:** Read the feedback file for full details. Pass to plan-agent for revision.

### Codex Failed

```
CODEX_FAILED:<reason>
CODEX_SESSION:abc-123-def
LOG_ID:550e8400-e29b-41d4-a716-446655440000
```

**Action:** Announce the failure reason. Ask the user to retry or abort. Do NOT increment the round counter.

### Empty Response

```
CODEX_EMPTY
CODEX_SESSION:abc-123-def
LOG_ID:550e8400-e29b-41d4-a716-446655440000
```

**Action:** Announce empty response. Ask the user to retry or abort. Do NOT increment the round counter.

## How It Works

1. Builds a round-aware review prompt: round 1 performs a broad but material audit of both the chosen approach and the task details; rounds 2-4 verify prior findings and look only for net-new material issues; rounds 5+ only flag blocker-level issues that would likely lead to wrong behavior
2. If `--session-id` is provided, attempts `codex exec resume` for context continuity; falls back to a fresh session if resume fails
3. Parses the Codex JSON stream for `thread.started` (thread ID) and `item.completed`/`agent_message` (feedback text)
4. If session resume succeeds but no new `thread.started` event appears, the input session ID is preserved and re-emitted (prevents losing session continuity)
5. Writes full feedback text to `--feedback-file`; emits only machine-parseable tokens to stdout
