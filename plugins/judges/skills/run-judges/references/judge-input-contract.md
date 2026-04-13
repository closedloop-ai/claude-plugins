# Judge Input Contract

This document defines the canonical contract for `$CLOSEDLOOP_WORKDIR/judge-input.json`.

All judge runs (plan/code/prd) must construct this envelope before launching judge agents.

## Required Path

- Output file: `$CLOSEDLOOP_WORKDIR/judge-input.json`
- Producer: orchestrator (for example, `run-judges`)
- Consumer: all judge agents

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `evaluation_type` | string | Evaluation mode: `plan`, `code`, or `prd` |
| `task` | string | Natural-language objective judges must evaluate against |
| `primary_artifact` | object | Primary evidence descriptor |
| `supporting_artifacts` | array | Secondary evidence descriptors |
| `source_of_truth` | array | Ordered artifact IDs defining evidence priority |
| `fallback_mode` | object | Fallback metadata and artifact declarations |
| `metadata` | object | Run metadata (`run_id`; optional fields like `generated_at`) |

## Artifact Descriptor Shape

Each artifact entry (`primary_artifact` and items in `supporting_artifacts`) should follow this shape:

```json
{
  "id": "plan_context",
  "path": "/abs/path/to/plan-context.json",
  "type": "json",
  "required": true,
  "description": "Compressed plan context bundle"
}
```

## Behavior Rules

1. Judges must read `judge-input.json` before reading any mapped artifact.
2. Judges should treat `primary_artifact` as authoritative and use `supporting_artifacts` as secondary evidence.
3. File names are not hardcoded by judges; orchestrator mapping defines which artifacts apply.
4. File-specific assumptions (for example `plan.json`, `prd.md`) are allowed only when:
   - `fallback_mode.active = true`, and
   - fallback artifacts are explicitly mapped in the envelope.

## Fallback Semantics

`fallback_mode` should provide:

- `active` (boolean)
- `reason` (string)
- `fallback_artifacts` (array of artifact IDs or descriptors)

When `active = false`, judges should ignore legacy fallback paths unless they are explicitly mapped as primary or supporting artifacts.

## Validation Guidance

Before launching judges, orchestrator should verify:

- `judge-input.json` exists and parses as valid JSON
- all required fields are present
- all required mapped artifact paths exist and are readable

## PRD Evaluation Envelope

When `evaluation_type` is `prd`, the envelope shape is:

- `primary_artifact`: points to `$CLOSEDLOOP_WORKDIR/prd.md` (required)
- `supporting_artifacts`: conditionally populated with pre-exploration artifacts when present:
  - `investigation-log.md` — codebase findings from @code:pre-explorer
  - `code-map.json` — targeted file discovery map
  - `requirements-extract.json` — structured PRD extraction
  If none are present, `supporting_artifacts` is `[]`.
- `source_of_truth`: `["prd"]`
- context-manager-for-judges is NOT invoked for PRD type; judge-input.json is built directly by run-judges.
