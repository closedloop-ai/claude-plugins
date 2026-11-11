# Provider text for skills/fleet-orchestrator/references/templates.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: inherited-scope-a -->
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion you inherit from the previous writer (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
<!-- end: inherited-scope-a -->

<!-- block: inherited-scope-b -->
Inherited scope: trace every exclusion, deferral, "obsolete" or narrowed criterion the previous writer left (its plan, PLN, change log or report) to a human source: a ticket AC, a PRD line, an operator ruling, or a plan with a named human approver. Anything without one is built or escalated, never dropped; `rulings-check.mjs --plan` lists a linked PLN's uncited exclusions.
<!-- end: inherited-scope-b -->

<!-- block: graph-first -->
Research graph-first with closedloop-graph before searching files by hand, as vibe requires: ticket_detail for the ticket and its PRD, query_collisions and blast_radius_tickets for overlapping work, code_callers and code_importers before a shared change.
<!-- end: graph-first -->
