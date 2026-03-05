---
name: build-status-cache
description: |
  Skip Phase 7 rebuild when no code changed since Phase 5 build passed.
  Compares git diff hash against stored hash from last successful build validation.
  Triggers on: entering Phase 7, checking build status, before final build validation.
  Returns BUILD_CACHE_HIT to skip or BUILD_CACHE_MISS to re-run build-validator.
context: fork
allowed-tools: Bash
---

# Build Status Cache

Check whether a Phase 7 build-validator launch can be skipped because no code has changed since Phase 5 build validation passed.

## When to Use

1. **After Phase 5 build passes:** Stamp the cache
2. **At Phase 7 build check:** Check the cache before launching build-validator

## Usage

The `scripts/` directory is relative to this skill's base directory (shown above as "Base directory for this skill").

### Stamp (after Phase 5 build passes)

```bash
bash <base_directory>/scripts/check_build_cache.sh <WORKDIR> stamp
```

Output: `BUILD_CACHE_STAMPED`

### Check (before Phase 7 build)

```bash
bash <base_directory>/scripts/check_build_cache.sh <WORKDIR>
```

## Interpreting Output

### Cache Hit

```
BUILD_CACHE_HIT
```

**Action:** Skip the Phase 7 build-validator launch. Build was already validated and no code changed.

### Cache Miss

```
BUILD_CACHE_MISS
reason: <why the cache is stale or missing>
```

**Action:** Run build-validator as normal.

## How It Works

The script hashes `git diff HEAD` output (all uncommitted changes). After Phase 5 passes, this hash is stored. Before Phase 7 runs, the current hash is compared. If Phase 6 (visual QA) made code fixes, the hash changes and build-validator re-runs. If Phase 6 was skipped or made no code changes, the hash matches and build-validator is skipped.
