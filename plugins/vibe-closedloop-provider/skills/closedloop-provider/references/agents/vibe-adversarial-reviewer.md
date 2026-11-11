# Provider text for agents/vibe-adversarial-reviewer.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: plan-exclude -->
Exclude exactly `.closedloop-ai/vibe-plans/` from this deliverable file list,
not other ClosedLoop artifacts; read those private plans only for context.
<!-- end: plan-exclude -->

<!-- block: graph-required -->
closedloop-graph is required, per `provider:closedloop-graph.md`: `code_callers` / `code_importers` to find every consumer of a changed component or hook, `code_tests_for` to find the tests that should still hold, and `blast_radius_tickets` to spot in-flight work on the same files. End your result with the Graph block.
<!-- end: graph-required -->

<!-- block: shared-consumers -->
   (closedloop-graph `code_callers` and `code_importers`). A prop default,
<!-- end: shared-consumers -->
