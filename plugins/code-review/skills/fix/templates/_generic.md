### ⚠️  {category} / {subcategory} — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Explanation:**
{explanation}

**Recommendation:** {recommendation}

**Why this is surfaced manually:** /fix does not have a dedicated dispatch handler for this category/subcategory combination yet. The most conservative action is to surface the finding for operator decision rather than guess at an auto-fix strategy.

**Code snippet at cited location:**
```
{code_snippet}
```

Re-assert via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id}` if you believe the finding is incorrect. (Resolve `<CACHE_DIR>` from `<CR_DIR>/cache_config.json:cache_dir`.)
