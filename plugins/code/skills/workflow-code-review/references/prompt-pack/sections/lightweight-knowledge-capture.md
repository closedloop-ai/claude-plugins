# Lightweight Knowledge Capture

After a work item's PR lifecycle gate passes, run lightweight knowledge capture for that work item before marking the work item complete.

If the work item produced multiple PRs across repositories, run knowledge capture only after all PRs for that work item are ready for human merge or have reported external blockers.

Do not wait for unrelated work items in the same goal.

## Candidate Notes

During planning, auto-execution eligibility, execution-prep, execution, implementation review, fix, re-check, final workflow-code-review, finalization, PR lifecycle handling, and merge coordination, relevant subagents must evaluate whether the work revealed stable architecture patterns or cross-repo relationships likely to help future goals.

Each relevant subagent return packet must include one of:

```text
candidate_knowledge_notes:
  - path: <candidate note path>
    summary: <short summary of stable reusable fact>
```

or:

```text
candidate_knowledge_notes: none
candidate_knowledge_notes_reason: <short reason>
```

This evaluation should stay quiet for ordinary task status. Write candidate notes only when the work reveals a stable, source-backed, reusable pattern that is generalizable beyond the current task.

Candidate notes must be written under:

```text
${WORKFLOW_MEMORY_ROOT}/candidates/
```

Use this filename shape:

```text
<goal-slug>.<work-item-id>.<agent-role>.md
```

When `{{WORKFLOW_CLI}}` is available (for example in the orchestrator), prefer the typed command instead of hand-authoring the file:

```sh
{{WORKFLOW_CLI}} memory note --goal-slug <goal-slug> --work-item-id <work-item-id> --agent-role <agent-role> --title <title> --trigger <keywords> --repo <repos> --fact <concise fact> --paths <useful starting paths> --evidence <inspected paths> --why <why reusable>
```

It derives the correct `<goal-slug>.<work-item-id>.<agent-role>` filename and emits the exact field shape below, so `{{WORKFLOW_CLI}} memory curate` reliably finds and can promote the note. Always pass your own `--agent-role` so candidate provenance is accurate; only the orchestrator may omit it, in which case the role defaults to `orchestrator`. Write the file by hand only when the CLI is unavailable, and match the filename and field shape exactly so curation can match it.

Subagents must not write directly to the curated memory entries.

## Memory Authority Boundary

Workflow workers and subagents must treat curated memory as append-only. When they
discover a reusable source-backed correction, they may write candidate notes or
use `workflow-memory add` when a handoff explicitly allows it, but they
must not delete, edit, rename, or merge existing curated entries. If existing
memory looks stale or conflicting during workflow execution, they must verify
against current source and record the correction as a candidate or superseding
entry instead of rewriting memory in place.

This worker safety rule is not the policy for a human maintainer or assistant
explicitly acting outside workflow execution to curate the memory store. An
out-of-band curator may directly correct, merge, retract, or remove curated memory
entries after verifying the source evidence and running memory validation.
Out-of-band curators must not leave known-wrong active memory in place merely
because workers are append-only.

Candidate notes are hints only. They are never source of truth and must be verified against current source before reuse.

Only capture facts that are:

- stable across future work
- source-backed by repo paths or contracts
- useful for reducing future exploration
- generalizable beyond the current ticket
- not too granular to matter outside the current patch

Do not capture:

- task status
- PR-specific details
- transient bugs
- command output
- secrets or credentials
- speculative conclusions
- obvious facts already in `AGENTS.md`

Each candidate note must be short and use this shape:

```text
## <Short Title>

- Trigger keywords: <comma-separated keywords>
- Repos involved: <repo list>
- Concise fact: <1-3 sentences>
- Useful starting paths: <paths>
- Evidence inspected: <paths/contracts>
- Why reusable: <1 sentence>
```

## Durable Quality Incidents

Before curation, closeout must extract compact quality incidents for the work item:

```sh
{{WORKFLOW_CLI}} quality-incidents --goal-slug <goal-slug> --work-item-id <work-item-id>
```

This command reads ledger evidence, PR lifecycle summaries, review lane findings, manual regression evidence, and available decision-table closeout sections. It writes normalized JSON incidents under:

```text
${WORKFLOW_MEMORY_ROOT}/quality-incidents/<repo-key>/
```

Quality incidents are granular learning inputs. They are not blocking rules by themselves and must not hardcode repo-specific policy into workflow. Recurring incidents can later be processed by the `quality-incident-hardener` skill into non-enforcing guardrail proposals under `guardrail-proposals/`.

Keep this separate from `failure_intake/`: failure intake records workflow-level failures that should harden the orchestration system; quality incidents record ordinary PR/review/QA/fix patterns that may become repo-local guardrails.

Even when no incidents are found, `{{WORKFLOW_CLI}} quality-incidents` records checked evidence under `qualityIncidents` in the ledger so closeout can proceed honestly.

## Curation

At work-item closeout, the runner must first capture durable quality incidents, then schedule deterministic memory curation before the work item can be marked complete. The orchestrator should run:

```sh
{{WORKFLOW_CLI}} memory curate --goal-slug <goal-slug> --work-item-id <work-item-id>
```

The command reviews candidate notes for that work item, promotes at most 3 high-value notes into:

```text
${WORKFLOW_MEMORY_ROOT}/shared/entries/
```

and records ledger evidence under `knowledge`: candidate notes checked, candidate note paths, promoted count, rejected count, curated timestamp, and summary.

Promote only notes that are stable, source-backed, generalizable, 150 words or less, and likely to reduce future exploration. Reject one-off implementation details, PR-only facts, command output, transient failures, unverified assumptions, malformed notes, duplicate hints, and notes too long to remain lightweight.

If a durable rule would prevent future mistakes, prefer updating the relevant repo's `AGENTS.md` instead of adding a memory hint.

If no candidate note is found or worth promoting, `{{WORKFLOW_CLI}} memory curate` still records checked evidence so closeout can proceed honestly.

## Future Use

At the start of planning, scan `${WORKFLOW_MEMORY_ROOT}/shared/entries/` for entries whose trigger keywords match the work item, repo, route, API, or feature area.

Use matching entries only as hints. Verify against current code before relying on them.
