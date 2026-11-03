### ⚠️  Coverage Gap — `{system_marker}`  ({severity})

**Issue:** {issue}

**Why this is surfaced manually:** A required reviewer either failed to run or was unavailable. Auto-fixing is not possible — the gap is in *review coverage*, not in code. Two valid resolutions:

**Option 1 — Re-run the review** (preferred when the failure was transient):

```
/start <SCOPE>            # local mode
/start --github <PR#>     # GitHub mode
```

**Option 2 — Manual acknowledgment** (use when the reviewer is permanently unavailable in this codebase OR human review covers the gap):

Add an entry to `.closedloop-ai/coverage-acknowledgments.json`:

```json
{
  "acknowledgments": [
    {
      "pr": "PR#<NUMBER>",
      "branch": "<BRANCH_NAME>",
      "reviewer": "<reviewer-name-from-system_marker>",
      "acknowledged_by": "<your handle>",
      "rationale": "<why human review is sufficient>",
      "acknowledged_at": "<ISO-8601 timestamp>",
      "expires_at": "<ISO-8601 timestamp, typically 7 days out>"
    }
  ]
}
```

The acknowledgments file is read by the `verify-coverage` stage (ships with PLN-725); until that ships, the file is informational only — your acknowledgment is recorded for audit but does not yet gate the verdict.

**Reviewer detail:** {explanation}

**Original recommendation:** {recommendation}
