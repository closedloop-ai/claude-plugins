### ⚠️  Pending Verification — `{file}:{line}`  ({severity} / {category} / {subcategory})

**Issue:** {issue}

**Explanation:**
{explanation}

**Why this is surfaced manually:** This finding lives in `envelope.pending_verification[]`, which means the upstream verifier (PLN-722) did NOT produce a verdict for it. Common causes:

- The verifier budget cap (`VERIFY_MAX_VERIFICATIONS`) deferred it past this run.
- A verifier subagent crashed or timed out.

**`/fix` does NOT re-verify these findings.** Verification is the code-review pipeline's job (`cmd_verify_prepare` + `cmd_verify_consolidate`); having `/fix` run a parallel verifier would duplicate that machinery and let `/fix` drift from the canonical verifier prompt over time.

**Your options:**

1. **Re-run the review** (preferred when the failure was transient):
   ```
   /start <SCOPE>            # local mode
   /start --github <PR#>     # GitHub mode
   ```
   The verifier runs again on the same finding set; verdicts get populated; `/fix` then dispatches normally.

2. **Re-assert** if you've already convinced yourself the finding is real and want to skip a second verifier pass:
   ```
   python3 <plugin>/tools/python/code_review_helpers.py re-assert --cr-dir <CR_DIR> --cache-dir <CACHE_DIR> --finding-ids {id} --reason '<why>'
   # Resolve <CACHE_DIR> from <CR_DIR>/cache_config.json:cache_dir
   ```
   This promotes the finding to `verified[]` with `verifier_verdict=RE_ASSERTED`, after which `/fix` will dispatch it to the appropriate auto-action bucket on the next run.

3. **Fix by hand** if the finding is clearly correct and you don't want to involve the orchestrator. The skill summary will still record the manual-surface route so the audit trail is intact.

**Original recommendation:** {recommendation}
