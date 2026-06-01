### ⚠️  Premise / Necessity — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Counter-evidence from the codebase:**
{reasoning_certificate.counter_evidence}

**Why this is surfaced manually:** The reviewer determined the stated motivation for this change is contradicted by codebase evidence. Auto-reverting is unsafe — the original author may have context the reviewer lacks.

**Your options:**
1. **Revert** the change if the counter-evidence above is correct.
2. **Justify** the change by adding a code comment within 5 lines of `{file}:{line}` explaining why the counter-evidence does not apply here.
3. **Re-assert** the original intent via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id} --reason '<why>'` if you believe the reviewer is wrong. (Resolve `<CACHE_DIR>` from `<CR_DIR>/cache_config.json:cache_dir`.)

**Original recommendation:** {recommendation}
