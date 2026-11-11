# Provider text for skills/fleet-orchestrator/SKILL.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: sequencing-ruling -->
   Before recording a sequencing ruling, run `node ../handoff/scripts/rulings-check.mjs --sequencing <candidate-ruling.md> --pr-tickets <pr-number-to-ticket.json>`, resolve every pull request number to its ticket, and report every reference that cannot be resolved. For each resolved dependency, call `create-artifact-link` with `BLOCKS` from the prerequisite ticket to the waiting ticket and list the links to confirm them. Normalize that receipt as blocker-to-blocked link JSON, then run `node ../handoff/scripts/rulings-check.mjs --record-sequencing <candidate-ruling.md> --program <orchDir>/rulings.md --pr-tickets <pr-number-to-ticket.json> --links <confirmed-links.json>`. This command is the only sequencing-ruling writer: it refuses a missing link and appends only after every receipt matches. A direction authored by the orchestrator stays operational text marked `(orchestrator)` and never enters `rulings.md`; only quoted operator words with their source use this path.
<!-- end: sequencing-ruling -->

<!-- block: machines -->
Works on one machine with no remote config. More machines need ssh key auth between them, plus `codex`, `node`, `gh`, this plugin and the closedloop-graph MCP server on each. Prerequisites, `config.env` keys and the checklist: [references/setup.md](./references/setup.md).
<!-- end: machines -->

<!-- block: intel-row -->
| Ticket overlap, scope collisions, "did a human ask for this", drift tracing | `closedloop-core:closedloop-intel`, read-only, over the closedloop-graph MCP server | closedloop-core | closedloop-graph tools directly |
<!-- end: intel-row -->

<!-- block: shapes -->
- Both shapes: Principles (evidence before every claim), Setup, Research with closedloop-graph, State and persistence (resume log, rulings), Pushback, Lessons loop, Artifacts people read, Reporting to the operator.
<!-- end: shapes -->

<!-- block: research -->
## Research with closedloop-graph

The closedloop-graph MCP server is required; decide from it, not from guesses. Tool guide: [vibe's closedloop-graph reference](../vibe/references/closedloop-graph.md).

- Before assigning work or ruling between PRs, check `query_collisions` and `blast_radius_tickets`, read PRD lineage with `ticket_detail`, and resolve tickets to screen map entries when the repo publishes them. Shared entries count as overlap across files; assign one owner or an explicit merge order.
- Every status sweep includes the current `rulings.md` text, the PR-number-to-ticket resolutions, and the live BLOCKS links in the `status-audit.mjs` snapshot. Fix every `SEQUENCING-BLOCKS-MISSING` finding by creating and confirming that blocker-to-blocked link; report `SEQUENCING-UNRESOLVED` references instead of skipping them.
- Before dispatching a ticket, and in every QA-prep brief, run vibe's newest-ruling search ([requirements worker](../../agents/vibe-requirements-worker.md), Newest ruling); on a hit, stop and ask the operator. It needs no vibe session. In Claude Code, run the requirements worker through the launcher in sessionless startup mode, never through the native Agent tool and never as a general worker in its place: `node ../vibe/scripts/dist/claude-worker.mjs` with one JSON object on stdin, `{"worktree": "<checkout root>", "agentName": "vibe-requirements-worker", "mode": "request", "requestId": "<id>", "input": "<brief>", "capabilities": [<every graph and live read you can see>], "sessionless": {"kind": "startup"}}`.
- In the same step, check every plan linked to the ticket (`list-artifact-links`, PRODUCES) with `node ../handoff/scripts/rulings-check.mjs --plan <json> --plan-body <text>`. Each exclusion it reports is scope the brief tells the writer to build, or you escalate; never one to skip.
- Before a shared change, read its callers and importers (`code_callers`, `code_importers`).
<!-- end: research -->

<!-- block: units -->
Related tickets go to one writer, one branch and one PR; each keeps its own criteria and statuses. When the program works a PRD, every open ticket under it assigned to the operator is one unit per repository. Steps and the candidate sources: `provider:ticket-units.md`.

1. Before starting any writer, on resume, after a merge and when new tickets arrive, gather the candidates (each with its PRD and whether the operator is its assignee) and run `scripts/ticket-units.mjs group --candidates <file> --board <orchDir>`.
2. Tell the operator its lines: one per unit, with what joined, what stayed apart and why.
3. Record each unit with `board.mjs <orchDir> unit`; fold a related ticket into the running writer, never a second one.
4. Before calling the unit ready, record its review of the completed work: `../handoff/scripts/unit-review.mjs ... --record <orchDir> --unit <name>`. Every member criterion and the PRD's criteria for the touched pages each need a code review row and a visual QA capture per page and surface it names. Send its `GAP` lines to the operator by ticket and criterion number; the unit is not ready until there are none.
5. Move each ticket yourself (In Progress at start, In Review at PR open once the review passed, Done at merge), audit with `status-audit.mjs --board`, and close the unit with `board.mjs <orchDir> unit <name> --closed <PR>` once every member is reconciled; both refuse a unit without a passing review.

<!-- end: units -->

<!-- block: status-sweep -->
- The status sweep, a standing `status-sweep` duty. At every writer assignment and every merge, and at every status report, snapshot each in-scope PRD's children (status, writer, PRs, latest body of each merged or DONE one, plans, absorbing umbrella) and run `node scripts/status-audit.mjs --snapshot <file>` until each `MISMATCH`, `UNOWNED`, `UNREAD`, `UNCHECKED`, `PLAN-OPEN` and `ABSORBED-OPEN` child is fixed or under `outOfScope` with who ruled it out. Closing an umbrella closes its absorbed children in the same step. A merge alone never makes a ticket DONE: its criteria are checked against the merged code first. Pass `--at assignment|merge|report`; with `FLEET_TRIM_STATUS_AUDIT=1` (off by default) a `report` run is skipped.
<!-- end: status-sweep -->

<!-- block: ruling-renderers -->
- A settled UX ruling is saved once as a reference file with its screenshots in a shared evidence location. Find every renderer of the behavior with `code_grep` across each open PR's diff and main, then `board.mjs <orchDir> deliver <ruling> --kind ruling --reference <file> --to <every owning writer and QA guide>`. Every QA plan for that behavior cites it; one shared component beats each PR building its own.
<!-- end: ruling-renderers -->
