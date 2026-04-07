---
name: critic-cache
description: |
  Check if critic reviews are still valid before re-running Phase 2.5 critics.
  Compares plan.json + critic-gates.json content hash against stored hash from last critic run.
  Triggers on: entering Phase 2.5, checking critic cache, before launching critics.
  Returns CRITIC_CACHE_HIT to skip critics or CRITIC_CACHE_MISS to re-run them.
context: fork
allowed-tools: Bash
---

# Critic Cache

Check whether prior critic reviews are still valid, avoiding redundant Sonnet agent launches when the plan hasn't changed since the last critic run.

## When to Use

Activate this skill at the start of Phase 2.5 (Critic Validation), **before** launching any critic agents. If the cache is fresh, skip the entire critic phase.

## Usage

Run the cache check script. The `scripts/` directory is relative to this skill's base directory (shown above as "Base directory for this skill"):

```bash
bash <base_directory>/scripts/check_critic_cache.sh <WORKDIR>
```

## Interpreting Output

### Cache Hit

```
CRITIC_CACHE_HIT
```

**Action:** Skip all critic agent launches. Proceed directly to Phase 2.6 (or Phase 2.7 if no merge is needed). The existing `$WORKDIR/reviews/*.review.json` files are still valid.

### Cache Miss

```
CRITIC_CACHE_MISS
reason: <why the cache is stale or missing>
```

**Action:** Run critics as normal. After all critics complete, stamp the cache:

```bash
if [ -f ".closedloop-ai/settings/critic-gates.json" ]; then
  cat $WORKDIR/plan.json .closedloop-ai/settings/critic-gates.json | shasum -a 256 > $WORKDIR/reviews/.plan-hash
else
  shasum -a 256 $WORKDIR/plan.json > $WORKDIR/reviews/.plan-hash
fi
```

## How Freshness Works

The script hashes both `plan.json` and `.closedloop-ai/settings/critic-gates.json` (if it exists) into a single combined hash. This ensures:
- Plan content changes → cache miss → critics re-run
- Critic configuration changes (adding/removing critics) → cache miss → critics re-run
- No changes → cache hit → critics skipped

## Cache Conditions

Cache hit requires ALL of:
1. `plan.json` exists
2. `reviews/` directory exists with at least 1 `.review.json` file
3. `reviews/.plan-hash` exists
4. Current combined hash matches stored hash
