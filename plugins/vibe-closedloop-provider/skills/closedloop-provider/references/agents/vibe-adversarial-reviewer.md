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
1. Shared components: for every changed component or hook in a shared UI
   package (a shared app package or the design system), find every consumer
   (closedloop-graph `code_callers` and `code_importers`). A prop default,
   removed prop, or changed layout that breaks another screen is a finding.
   When more than one app mounts the shared package (for example a web app
   and a Desktop renderer), check the consumers in each. So are a consumer
   class or cascade layer beating an attribute-styled contract, plumbing
   that changes render props, and a migrated control off the route's render
   path or a replaced one with no new home.
<!-- end: shared-consumers -->
