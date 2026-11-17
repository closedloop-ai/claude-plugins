# Provider text for skills/fleet-orchestrator/references/templates.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: inherited-scope-a -->
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion you inherit from the previous writer (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
<!-- end: inherited-scope-a -->

<!-- block: inherited-scope-b -->
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion the previous writer left (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
<!-- end: inherited-scope-b -->

<!-- block: graph-first -->
Graph first: ticket/PRD, collisions, blast radius, then shared callers/importers. Tests use `code_tests_for_changes` over the diff (`code_tests_for` for one file); E2E uses lanes/behavior refs. A managed Codex reviewer reads graph first or returns its approval refusal.
<!-- end: graph-first -->
