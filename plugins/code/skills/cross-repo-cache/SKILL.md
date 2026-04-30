---
name: cross-repo-cache
description: |
  Check if cross-repo coordinator results can be reused, avoiding redundant Sonnet agent launches.
  Compares peer repo git hashes against stored hashes from last coordinator run.
  Triggers on: entering Phase 1.4.1, checking cross-repo cache, before discovering peers.
  Returns CROSS_REPO_CACHE_HIT with cached status or CROSS_REPO_CACHE_MISS to re-run coordinator.
context: fork
allowed-tools: Bash
---

# Cross-Repo Cache Skill

Check whether prior cross-repo coordinator results are still valid, avoiding redundant Sonnet agent launches when peer repositories haven't changed.

## When to Use

Activate this skill at the start of Phase 1.4.1 (Discover peers), **before** launching `@code:cross-repo-coordinator`. If the cache is fresh, skip the coordinator and use cached results.

## Usage

### Check Cache (Phase 1.4.1)

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/check_cross_repo_cache.sh <WORKDIR>
```

### Stamp Cache (after coordinator completes)

After the cross-repo-coordinator runs successfully, stamp the cache:

```bash
# Compute hash of peer repo states
if [ -f ".workspace-repos.json" ]; then
  repo_hashes=""
  for repo_path in $(python3 -c "import json; [print(r['path']) for r in json.load(open('.workspace-repos.json')) if r.get('path')]" 2>/dev/null); do
    [ -d "$repo_path/.git" ] && repo_hashes="$repo_hashes$repo_path:$(git -C "$repo_path" rev-parse HEAD 2>/dev/null || echo unknown) "
  done
  echo "$repo_hashes" | shasum -a 256 > $WORKDIR/.cross-repo-hash
else
  shasum -a 256 $WORKDIR/.cross-repo-needs.json > $WORKDIR/.cross-repo-hash
fi
```

## Interpreting Output

### Cache Hit

```
CROSS_REPO_CACHE_HIT
status: NO_CROSS_REPO_NEEDED | CAPABILITIES_IDENTIFIED
capabilities:
  - peer-name: capability description
```

**Action:**
- If status is `NO_CROSS_REPO_NEEDED`: Mark 1.4.x phases complete, proceed to Phase 2
- If status is `CAPABILITIES_IDENTIFIED`: Skip coordinator, proceed to Phase 1.4.2 with cached capabilities

### Cache Miss

```
CROSS_REPO_CACHE_MISS
reason: <why the cache is stale or missing>
```

**Action:** Launch `@code:cross-repo-coordinator` as normal. After it completes, stamp the cache.

## How Freshness Works

The script hashes the git HEAD commit of each peer repository listed in `.workspace-repos.json`. If any peer has new commits, the hash changes and the coordinator re-runs. This correctly handles the case where a peer repo is updated between iterations.

## Cache Location

- Coordinator results: `$WORKDIR/.cross-repo-needs.json` (written by coordinator)
- Cache hash: `$WORKDIR/.cross-repo-hash` (written by stamp step)
- Per-repo cache: `.learnings/cross-repo-cache/{repo-name}/` (used by generic-discovery agents)
