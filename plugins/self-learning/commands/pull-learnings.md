---
description: Pulls shared organization patterns into local org-patterns.toon
---

# Pull Learnings Command

Imports organization patterns from a shared repository into local TOON format.

## Prerequisites

- `CLAUDE_ORG_ID` environment variable must be set
- Must run `git pull` first to get latest shared patterns
- Local `.learnings/` directory must exist

## Process

1. **Read shared patterns**: Load `$CLOSEDLOOP_WORKDIR/.closedloop-ai/learnings/org-patterns.json`
2. **Convert JSON → TOON**: For LLM consumption
3. **Regenerate local IDs**: Maintain unique IDs within local file
4. **Skip echo patterns**: Exclude patterns that originated from this project
5. **Merge into local**: Update `$CLOSEDLOOP_WORKDIR/.learnings/org-patterns.toon`

## Echo Prevention

To avoid circular pattern propagation:
1. Read `sources.json` to identify pattern origins
2. Skip patterns where `source_project` matches current project
3. This prevents: Project A → Shared → Project A (echo)

## JSON to TOON Conversion

```
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

# TOON
P-001|org|pattern|auth_flow|high|5|0.85||impl-subagent,"Check token expiry"
```

## Merge Strategy

When merging into local patterns:
1. **New patterns**: Append to file with new local ID
2. **Existing patterns** (same trigger): Update metadata, keep higher seen_count
3. **Conflicting patterns**: Prefer pattern with higher success_rate

## Local ID Generation

Local IDs are regenerated during pull to:
- Avoid collisions with existing local patterns
- Maintain consistent ID sequence in local file
- Original shared ID preserved in metadata comment

## Usage

```bash
# First, pull latest from remote
git pull origin main

# Then pull learnings (via ClosedLoop orchestrator)
# Requires CLAUDE_ORG_ID to be set
export CLAUDE_ORG_ID="my-organization"
```

## Output

Updates `$CLOSEDLOOP_WORKDIR/.learnings/org-patterns.toon` with:
- New patterns from shared repository
- Updated metadata for existing patterns
- Comments indicating pattern sources
