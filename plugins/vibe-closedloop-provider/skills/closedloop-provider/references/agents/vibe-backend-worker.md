# Provider text for agents/vibe-backend-worker.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-list -->
- `../skills/vibe/references/closedloop-graph.md`,
  `../skills/vibe/references/quality-loop.md` (internal plan, lean build loop, graph-first product questions),
  `../skills/vibe/references/design-pass.md` (Owner rules),
  `../skills/vibe/references/guardrails.md` (What may change, Tests, and
  Checks), and `../skills/vibe/references/ticket-template.md`.
<!-- end: read-list -->

<!-- block: ground -->
1. Ground it. closedloop-graph is required (`closedloop-graph.md`,
   Required calls): `fts_search` and
   `search_memory_facts` for tickets or decisions about this data,
   `code_symbols` for the closest existing route, service, and model,
   `code_callers` for every consumer of anything you will change, and
   `blast_radius_tickets` on files you will edit. Reuse an existing endpoint
   or service when one already fits, and place new code by the owner rules in
   `design-pass.md`: an action the children of a shared parent need gets one generic
   endpoint and service they all call, not one per child.
<!-- end: ground -->

<!-- block: decision-table -->
2. Decision table first for every request, not only backend. Extend the existing
   session decision table per the `decision-table` skill
   (`.closedloop-ai/decision-tables/<session-slug>.md`): inputs, auth and org
   scoping, validation and error paths, empty and partial data, writes and
   their side effects, version skew with older Desktop builds. Use the person's
   stated rules verbatim; where a rule is missing and the code cannot decide it,
   apply the shared product research and necessity gate before returning
   `NEEDS_PERSON`; never ask a technical question or invent product behavior.
   Every malformed telemetry-metadata row names the existing monitored
   corruption event and the test that must assert it with its stable
   identifying fields. A test that expects no
   warning or error is not evidence when the repository contract requires that
   monitored event.
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
The advisor never performs the writing/recording steps above. Never publish a
technical plan or put its body in a ticket; only the ticket worker publishes
the session's plan, as its PLN.
<!-- end: plan-publish -->

<!-- block: return -->
`DONE` with existing or needed endpoint/type contracts, `Owner: <path>`,
migration/seed considerations and evidence for the sole writer. Never claim
advice was built. Or `NEEDS_PERSON`
with the product question, phrased in plain words for the person running the
session. Or `BLOCKED` with why.
End with the Graph block (`closedloop-graph.md`).
<!-- end: return -->
