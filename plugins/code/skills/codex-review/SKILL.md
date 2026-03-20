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
  --round <N> \
  --codex-model <model> \
  [--session-id <thread_id>]
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--plan-file` | Yes | -- | Absolute path to the plan file Codex should review |
| `--feedback-file` | Yes | -- | Path where full feedback text will be written |
| `--round` | No | 1 | Current debate round (affects review prompt intro) |
| `--codex-model` | No | gpt-5.4 | Codex model to use |
| `--session-id` | No | -- | Thread ID from a previous round for session resume |

## Interpreting Output

The script prints structured tokens to stdout. Parse these to control the debate loop.

### Approval

```
VERDICT:APPROVED
CODEX_SESSION:abc-123-def
```

**Action:** Announce approval. Clean up sidecar files. Stop the debate loop.

### Changes Requested

```
VERDICT:NEEDS_CHANGES
CODEX_SESSION:abc-123-def
```

**Action:** Read the feedback file for full details. Pass to plan-agent for revision.

### Codex Failed

```
CODEX_FAILED:<reason>
CODEX_SESSION:abc-123-def
```

**Action:** Announce the failure reason. Ask the user to retry or abort. Do NOT increment the round counter.

### Empty Response

```
CODEX_EMPTY
CODEX_SESSION:abc-123-def
```

**Action:** Announce empty response. Ask the user to retry or abort. Do NOT increment the round counter.

## How It Works

1. Builds a review prompt asking Codex to analyze the plan for technical soundness, missing steps, architectural issues, security/performance risks, and unclear descriptions
2. If `--session-id` is provided, attempts `codex exec resume` for context continuity; falls back to a fresh session if resume fails
3. Parses the Codex JSON stream for `thread.started` (thread ID) and `item.completed`/`agent_message` (feedback text)
4. If session resume succeeds but no new `thread.started` event appears, the input session ID is preserved and re-emitted (prevents losing session continuity)
5. Writes full feedback text to `--feedback-file`; emits only machine-parseable tokens to stdout
