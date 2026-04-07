---
description: Pushes local org-patterns to the shared organization repository
---

# Push Learnings Command

Exports local organization patterns to a shared repository for team-wide distribution.

## Prerequisites

- `CLAUDE_ORG_ID` environment variable must be set
- Git repository must be initialized
- Network access to remote repository

## Process

1. **Read local patterns**: Load `$CLOSEDLOOP_WORKDIR/.learnings/org-patterns.toon`
2. **Convert TOON → JSON**: For cross-project compatibility
3. **Regenerate pattern IDs**: Resolve collisions (P-001 might exist in target)
4. **Merge with shared patterns**: Read `$CLOSEDLOOP_WORKDIR/.closedloop-ai/learnings/org-patterns.json`
5. **Track source project**: Update `sources.json` with origin metadata
6. **Write merged output**: Save to shared location

## ID Collision Resolution

When merging patterns from multiple projects:
1. Load existing IDs from target file
2. For each new pattern:
   - If ID exists, generate new ID (P-XXX where XXX is next available)
   - Preserve original ID in metadata for traceability

## Source Tracking

`sources.json` format:
```json
{
  "patterns": {
    "P-001": {
      "source_project": "project-name",
      "source_id": "P-042",
      "pushed_at": "ISO8601",
      "pushed_by": "user@example.com"
    }
  }
}
```

## TOON to JSON Conversion

```
# TOON
P-001|org|pattern|auth_flow|high|5|0.85||impl-subagent,"Check token expiry"

# JSON
{
  "id": "P-001",
  "scope": "org",
  "category": "pattern",
  "trigger": "auth_flow",
  "confidence": "high",
  "seen_count": 5,
  "success_rate": 0.85,
  "flags": "",
  "applies_to": ["impl-subagent"],
  "summary": "Check token expiry"
}
```

## Usage

```bash
# Requires CLAUDE_ORG_ID to be set
export CLAUDE_ORG_ID="my-organization"
# Then invoke via ClosedLoop orchestrator
```

## Error Handling

- If `CLAUDE_ORG_ID` not set, exit with error
- If local patterns file missing, exit with error
- If merge conflict, prefer newer pattern (by timestamp)
