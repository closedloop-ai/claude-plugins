# The guardrails findings file

`../../handoff/scripts/guardrails-gate.mjs` runs the guardrails checks a script
can run, before any model reads the diff, and writes one JSON file. The
consolidated reviewer (WS4 R1) and `vibe-guardrails-reviewer` read it instead
of deriving the same facts again. This file is the one canonical statement of
its shape; `guardrails-gate.mjs` validates its own output against it
(`findingsProblems`) and a contract test pins both.

```json
{
  "schema": "vibe.guardrails-findings/1",
  "head": "<sha>",
  "base": "<sha>",
  "findings": [
    {
      "id": "<stable id>",
      "check": "<check name>",
      "file": "<path>",
      "line": 12,
      "severity": "high|medium|low",
      "message": "<text>",
      "evidence": "<string>"
    }
  ],
  "checks_run": ["<name>"],
  "checks_skipped": [{ "name": "<name>", "reason": "<text>" }]
}
```

Rules every reader may rely on:

- The top level has exactly these six keys; each finding has exactly the seven
  keys above. `line` is an integer or `null`. A finding that belongs to the
  whole run rather than a file has `file` `"."`.
- `id` is `<check>:<10 hex>` from the check, file, line and message, so the
  same finding has the same id on every run.
- `head` is the commit that was checked and `base` the commit the diff is
  against (the main the session captured, or its merge-base with
  `origin/main`).
- Every finding's `check` is in `checks_run`.
- A check that did not run, for any reason, is in `checks_skipped` with its
  reason and never in `checks_run`. An empty `findings` list proves only the
  checks in `checks_run` found nothing: it never says a skipped or absent check
  passed. The judgment checks the reviewer owns (`main-sync-regressions`,
  `copy-provenance`, `accessibility`, `shared-owner`) are always listed as
  skipped.

Checks:

| Check | What it is |
|---|---|
| `biome` | The repository's `pnpm exec biome check` on the changed files; the script re-implements none of its rules |
| `source-gates` | The repository's `pnpm check:source-gates` |
| `diff-rules` | `diff-rules.mjs`'s blocking findings, the same ones `handoff-inventory.mjs` reports |
| `tokens` | Hardcoded hex colors, arbitrary pixel values and inline styles in added UI and CSS lines |
| `conventions` | TypeScript `enum`, `as` casts, `console` calls, raw internal `<a href>`, inline `import()` and files over 1,000 lines |
| `test-repair` | A changed, removed or added assertion in an edited test file, with the words that differ |
| `owner-duplicates` | A new export whose name a file outside the change already exports |

The scripted checks report candidates with the line as evidence. The reviewer
still decides whether a candidate is a defect (a token the surface does not
bundle, for example, is not a finding the reviewer may accept without reading
`guardrails.md`, "Check the bundled tokens first"). Exit codes of the script: 0
no finding and every scriptable check ran, 1 at least one finding, 3 no finding
but a scriptable check was skipped, 2 the script could not run.
