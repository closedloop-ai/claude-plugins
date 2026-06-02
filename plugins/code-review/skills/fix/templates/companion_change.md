### ⚠️  CompanionChange — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Rule that triggered:** {reasoning_certificate.rule_name}
**Rationale:** {reasoning_certificate.rationale}
**Trigger evidence:** {reasoning_certificate.trigger_evidence}

**Missing companion(s):**
{reasoning_certificate.missing_companions}

**Why this is surfaced manually:** Companion-file content is context-dependent. The reviewer can detect that a companion file is missing, but cannot write the right content without knowing project specifics (column types, migration direction, schema validators, locale conventions, etc.).

**Your options:**
1. **Add the missing companion file(s)** listed above, then re-run the review.
2. **Justify the omission** in the PR description if the rule does not apply (e.g., schema-only test fixture, never deployed).
3. **Re-assert** via `python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id}`. (Resolve `<CACHE_DIR>` from `<CR_DIR>/cache_config.json:cache_dir`.)

**Original recommendation:** {recommendation}
