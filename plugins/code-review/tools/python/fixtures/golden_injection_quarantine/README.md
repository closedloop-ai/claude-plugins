# golden_injection_quarantine

PLN-720 end-to-end pipeline fixture.

Simulates a PR whose description triggered the prompt-injection detector
at severity High (score ≥ 70). The pre-baked inputs reflect the
post-detect-injection state:

- `intent_context.json` — post-quarantine: `body` redacted, `quarantine: true`
- `intent.json` — classifier output reflects the quarantine short-circuit
  (`intent: "mixed"`, `source: "quarantine"`)
- `agent_injection-detector.json` — the canonical BLOCKING `InjectionAttempt`
  finding emitted by detect-injection when severity ≥ High

The expected envelope shows the finding landed in `verified[]` via the
standard collect → validate → finalize-result pipeline (no special-case
routing), with verdict `CHANGES_REQUESTED` per canonical precedence
(rule 2: any BLOCKING → CHANGES_REQUESTED).
