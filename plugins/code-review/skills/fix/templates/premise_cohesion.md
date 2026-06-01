### ⚠️  Premise / Cohesion — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Prevailing pattern in this codebase:**
{reasoning_certificate.prevailing_pattern}

**Cited examples (the reviewer found 5+ sites following the prevailing pattern):**
{reasoning_certificate.cited_examples}

**Why this is surfaced manually:** Auto-refactoring to match the prevailing pattern would be a structural change to working code. The author may have a deliberate reason to diverge.

**Your options:**
1. **Refactor** `{file}:{line}` to match the prevailing pattern shown above.
2. **Justify the divergence** with a code comment within 5 lines of `{file}:{line}` explaining the reason (e.g., performance hot path, deliberate isolation, in-flight migration).
3. **Re-assert** via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --finding-ids {id} --reason '<why>'`.

**Original recommendation:** {recommendation}
