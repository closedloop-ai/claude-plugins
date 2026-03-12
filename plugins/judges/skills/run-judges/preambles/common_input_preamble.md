# Judge Input Contract

This preamble defines the canonical input-reading contract for all judges.

## Required Read Order

You MUST follow this sequence before analysis:

1. Read `$CLOSEDLOOP_WORKDIR/judge-input.json` first.
2. Parse envelope fields: `evaluation_type`, `task`, `primary_artifact`, `supporting_artifacts`, `source_of_truth`, `fallback_mode`, `metadata`.
3. Read mapped artifacts from envelope paths:
   - `primary_artifact` is authoritative evidence.
   - `supporting_artifacts` are secondary evidence in listed order.

Do not assume fixed artifact filenames unless they are explicitly mapped in the envelope.

## Source of Truth Policy

- Treat the envelope `task` as the evaluation objective.
- Prioritize evidence according to envelope mapping and source-of-truth ordering.
- Use fallback artifacts only when `fallback_mode.active = true` and fallback artifacts are explicitly declared.

