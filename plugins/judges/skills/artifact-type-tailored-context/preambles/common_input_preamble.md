# Shared Judge Input Contract (SSOT)

This preamble defines the canonical input-reading contract for all judges.

## Required Read Order

You MUST follow this sequence before analysis:

1. Read `$CLOSEDLOOP_WORKDIR/judge-input.json` first.
2. Parse envelope fields: `evaluation_type`, `task`, `primary_artifact`, `supporting_artifacts`, `source_of_truth`, `fallback_mode`, `metadata`.
3. Read mapped artifacts from envelope paths:
   - `primary_artifact` is authoritative evidence.
   - `supporting_artifacts` are source-of-truth evidence in listed order.
   - When `source_of_truth` is present, load artifacts in exactly that ID order.

Do not assume fixed artifact filenames unless they are explicitly mapped in the envelope.

## Source of Truth Policy

- Treat the envelope `task` as the evaluation objective.
- Prioritize evidence according to envelope mapping and source-of-truth ordering.
- Use fallback artifacts only when `fallback_mode.active = true` and fallback artifacts are explicitly declared.

## Error Handling Contract

If any of the following occur, return a CaseScore error result:

- `judge-input.json` missing, unreadable, or malformed JSON
- A required mapped artifact is missing or unreadable

For PRD and Feature runs only, a missing or malformed `judge-input.json` may fall
back to legacy `prd.md` paths when the run prompt explicitly says the mapper
failed and a one-run legacy fallback is active. Otherwise, treat the missing or
malformed envelope as an error.

Error response requirements:

- `final_status` must be `3`
- metric `score` should be `0.0`
- `justification` must include explicit file path and root cause details

## Compatibility Note

Judges may be reused across workflows; always trust orchestrator-provided envelope mappings over legacy path assumptions.
