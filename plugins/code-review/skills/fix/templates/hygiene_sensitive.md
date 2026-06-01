### ⚠️  Hygiene / Sensitive File — `{file}:{line}`  ({severity})

**Issue:** {issue}

**Why this is surfaced manually:** The hygiene check flagged a change to a file matching sensitive-file patterns (`.env`, `.pem`, `credentials.*`, `*.key`, etc.). /fix will never auto-modify or auto-delete a sensitive file — credential rotation, secret-revocation, and key-handling decisions require operator judgment.

**Your options:**
1. **Confirm intentional** — the change is correct (e.g., adding a new placeholder to `.env.example`, rotating a public key fingerprint).
2. **Revert the change** — `git checkout <FILE>` if the file should not have been committed.
3. **Investigate exposure** — if a secret was committed, treat as a credential leak: revoke, rotate, rewrite history.
4. **Update gitignore** — if the file should never be tracked, add it to `.gitignore` and remove from index with `git rm --cached <FILE>`.

**Reviewer detail:** {explanation}

**Original recommendation:** {recommendation}
