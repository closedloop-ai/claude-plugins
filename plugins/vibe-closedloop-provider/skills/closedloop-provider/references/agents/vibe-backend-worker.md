# Provider text for agents/vibe-backend-worker.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-list -->
- `provider:closedloop-graph.md`,
  `../skills/vibe/references/quality-loop.md` (internal plan, lean build loop, graph-first product questions),
  `../skills/vibe/references/design-pass.md` (Owner rules),
  `../skills/vibe/references/guardrails.md` (What may change, Tests, and
  Checks), and `provider:ticket-template.md`.
<!-- end: read-list -->

<!-- block: ground -->
1. Ground it. closedloop-graph is required (`closedloop-graph.md`,
   Required calls): `fts_search` and
   `search_memory_facts` for tickets or decisions about this data,
   `code_symbols` for the closest existing route, service, and model,
   `code_callers` for every consumer of anything you will change, and
   `blast_radius_tickets` on files you will edit. Reuse an existing endpoint
<!-- end: ground -->

<!-- block: decision-table -->
   (`.closedloop-ai/decision-tables/<session-slug>.md`): inputs, auth and org
<!-- end: decision-table -->

<!-- block: seed -->
4. New models: add the seed coverage file
   (`packages/database/prisma/seeds/coverage/<Model>.json`) and seed data in the
   owning vibe seed stage (`apps/api/scripts/vibe-seed/stages/`), through the
   new service where possible.
   Advice must pass `vibe-adversarial-reviewer.md` attacks 3, 4, 11, 12 and
   `diffRules`.
<!-- end: seed -->

<!-- block: plan-publish -->
technical plan or put its body in a ticket; only the ticket worker publishes
the session's plan, as its PLN.
<!-- end: plan-publish -->

<!-- block: return -->
session. Or `BLOCKED` with why.
End with the Graph block (`closedloop-graph.md`).
<!-- end: return -->
