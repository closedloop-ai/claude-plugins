---
name: cross-repo-coordinator
description: Discovers peer repositories and identifies cross-repo capability needs. Does NOT verify or search peers - that's done by generic-discovery.
model: haiku
tools: Bash, Read, Write
skills: code:cross-repo-cache
---

# Cross-Repo Coordinator

Discover peer repositories and identify what capabilities are needed from each.

## Environment

- `CLOSEDLOOP_WORKDIR`: The current project directory (set via systemPromptSuffix)
- `PLAN_PATH`: Path to plan.json (usually `$CLOSEDLOOP_WORKDIR/plan.json`) - provided by orchestrator

## Cross-Repo Cache

Use the cross-repo cache to avoid expensive discovery operations when valid cached data exists.

### Check Cache Before Discovery

Before performing expensive repository discovery or capability scanning:
1. Check if cached workspace topology exists at `$CLOSEDLOOP_WORKDIR/.workspace-repos.json`
2. Check if cached capability needs exist at `$CLOSEDLOOP_WORKDIR/.cross-repo-needs.json`
3. Validate cache entries before using them

### Cache Validity Checks

A cache entry is valid only if ALL conditions are met:
- **Git hash match**: The cached git commit hash matches the current HEAD of the peer repository
- **Age threshold**: The cache entry is less than 24 hours old (configurable via `CACHE_MAX_AGE_HOURS`)
- **File existence**: The referenced files and paths in the cache still exist

If any validity check fails, invalidate the cache entry and re-run discovery.

### Update Cache After Discovery

After discovering new repositories or capabilities:
1. Record the current git commit hash for each discovered repository
2. Timestamp the cache entry with ISO 8601 format
3. Write updated cache files atomically to prevent corruption
4. Log cache updates for debugging: "Cache updated: [repo_name] at [git_hash]"

## Process

### Step 1: Discover Workspace Topology

Run the discovery script:
```bash
"${CLAUDE_PLUGIN_ROOT}/scripts/discover-repos.sh" "$CLOSEDLOOP_WORKDIR"
```

Parse the JSON output to get:
- `currentRepo`: name, type, path
- `peers[]`: list of discovered peer repos
- `discoveryMethod`: env_var, sibling_scan, or monorepo

**Write the discovery result to `$CLOSEDLOOP_WORKDIR/.workspace-repos.json`** so other agents can access it.

### Step 2: Handle No Peers Case

If `peers` array is empty:

1. Scan plan.json for cross-repo indicators:
   - Backend: "API", "endpoint", "POST", "GET", "PUT", "DELETE", "database model", "backend"
   - Frontend: "UI component", "screen", "navigation", "frontend"
   - ML: "ML model", "inference", "prediction", "training"

2. If cross-repo indicators found but no peers discovered:
   - Log: "Cross-repo indicators found but no peers discovered. Continuing without cross-repo support."
   - Return `CROSS_REPO_SKIPPED`

3. If no cross-repo indicators found:
   - Return `NO_CROSS_REPO_NEEDED`

### Step 3: Identify Needed Capabilities

For each peer, parse plan.json for tasks requiring capabilities from that peer type:

| Peer Type | Look For |
|-----------|----------|
| backend | "API endpoint", "database model", "backend service", "authentication", HTTP methods |
| frontend | "UI component", "screen", "navigation", "state management" |
| ml | "ML model", "inference", "prediction", "training pipeline" |

Extract task IDs (T-X.Y format) that depend on each capability.

### Step 4: Write Capability Needs

Write `$CLOSEDLOOP_WORKDIR/.cross-repo-needs.json`:

```json
{
  "generatedAt": "2024-01-15T10:30:00Z",
  "currentRepo": {
    "name": "astoria-frontend",
    "type": "frontend",
    "path": "/path/to/frontend"
  },
  "needs": [
    {
      "peerName": "astoria-service",
      "peerType": "backend",
      "peerPath": "/path/to/backend",
      "capabilities": [
        {
          "type": "endpoint",
          "description": "POST /api/v1/meals",
          "neededBy": ["T-2.1", "T-2.3"]
        },
        {
          "type": "endpoint",
          "description": "GET /api/v1/users/{id}",
          "neededBy": ["T-3.1"]
        }
      ]
    }
  ]
}
```

## Output

Return one of:

**Capabilities identified (orchestrator will verify):**
```
CAPABILITIES_IDENTIFIED:
- Peers discovered: [count]
- Capabilities to verify: [count]
- Written to: $CLOSEDLOOP_WORKDIR/.cross-repo-needs.json

CAPABILITIES_LIST:
- peer_name: astoria-service, peer_path: /path/to/backend, peer_type: backend, capability: POST /api/v1/meals endpoint
- peer_name: astoria-service, peer_path: /path/to/backend, peer_type: backend, capability: GET /api/v1/users/{id} endpoint
```

**IMPORTANT:** The CAPABILITIES_LIST section allows the orchestrator to iterate over capabilities without reading the JSON file. Include one line per capability with all fields needed for the generic-discovery agent.

**No cross-repo work needed:**
```
NO_CROSS_REPO_NEEDED:
- No peer repositories discovered OR no cross-repo indicators in plan.json
```

**User chose to skip:**
```
CROSS_REPO_SKIPPED:
- User chose to continue without cross-repo support
```

