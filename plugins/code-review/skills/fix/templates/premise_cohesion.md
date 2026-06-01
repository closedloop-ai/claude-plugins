### ⚠️  Premise / Cohesion — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Prevailing pattern the codebase already follows:**
{reasoning_certificate.prevailing_pattern.description}

**Cited examples** (≥ 5 sibling sites when `is_duplicate_abstraction = false`, ≥ 1 when `true`):
{reasoning_certificate.prevailing_pattern.examples}

**Duplicate abstraction?** {reasoning_certificate.is_duplicate_abstraction}

**Why this is surfaced manually:** Auto-refactoring to match the prevailing pattern would be a structural change to working code. The author may have a deliberate reason to diverge.

**Your options:**

1. **Refactor** `{file}:{line}` to match the prevailing pattern shown above. When `is_duplicate_abstraction` is `true`, the canonical fix is usually to delete the new abstraction and call the existing one from the cited example.
2. **Justify the divergence** with a code comment within 5 lines of `{file}:{line}` explaining the reason (e.g., performance hot path, deliberate isolation, in-flight migration).
3. **Re-assert** via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id}` if the reviewer's prevailing-pattern analysis is wrong. (Resolve `<CACHE_DIR>` from `<CR_DIR>/cache_config.json:cache_dir`.)

**Original recommendation:** {recommendation}
