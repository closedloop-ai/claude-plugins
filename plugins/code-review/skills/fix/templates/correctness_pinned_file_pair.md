### ⚠️  Correctness / pinned-file-pair — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Changed file (finding anchor):** `{file}:{line}`
```
{code_snippet}
```

**Companion assertion(s) this change contradicts (other_locations, one `file:line — issue` per entry):**
{other_locations_rendered}

**Explanation:** {explanation}

**Why this is surfaced manually:** This defect spans two files and the fix almost never belongs at the anchor. Diff-scope validation requires the finding to anchor on the changed file, and auto-fix edits that anchor — so applying it would revert the intended config, workflow, or manifest change instead of updating the stale assertion that pins it. Which side is wrong is the operator's call: the change may be correct and the assertion stale, or the assertion may be the contract and the change a mistake. The companion file is also typically outside this review's diff, so `/fix` has not verified its current content.

**Your options:**
1. **Update the companion assertion** at the `other_locations[]` file:line above to match the changed file, if the change is intended.
2. **Revert or correct the change** at the anchor, if the pinned assertion is the contract being violated.
3. **Dismiss** if the companion test does not actually pin these lines — a test that only names the changed path as fixture input pins nothing, and this finding should not have been emitted.
4. **Re-assert** via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id}`. (Resolve `<CACHE_DIR>` from `<CR_DIR>/cache_config.json:cache_dir`.)

**Original recommendation:** {recommendation}
