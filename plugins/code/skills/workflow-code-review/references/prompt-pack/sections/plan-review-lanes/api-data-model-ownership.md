# API/Data-Model Ownership Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This lane reviews whether the proposed API, MCP, wire, shared type, persisted model, response field, domain relationship, lineage metadata, or projection belongs on the selected owning surface, or whether the plan duplicates, muddies, or bypasses an existing domain model. It is a core lane and always runs. This is separate from executor-readiness, adversarial contract, and security-abuse review. It must not implement fixes.

## Applicability

API/data-model ownership-sensitive work includes any work touching:

- public API, MCP, GraphQL, webhook, gateway, wire, route response, or response-field shape
- shared types, generated clients, schemas, package contracts, or published type surfaces
- persisted models, database tables, ORM models, relationships, lineage, parent/child links, ownership, status, permissions, or domain metadata
- cross-module projections, convenience fields, denormalized fields, compatibility shims, or fields copied from another domain owner
- sync, replay, refresh, import, migration, backfill, repair, or batch paths where more than one producer or write source can create or update the same logical resource
- consumer-facing behavior where the proposed route/service/module is not obviously the canonical owner

For such work, this lane must be substantive. If applicability is unclear, the lane must return a substantive finding or blocker rather than `not_applicable`.

## Required Checks

The reviewer must inspect the work item, generated plan, repo guardrails, existing route/service/module boundaries, persisted models, shared types, relevant consumers, and any cross-repo contracts needed to answer:

> Is this the right owning surface for the concept, or is the plan duplicating, muddying, or bypassing an existing domain model?

The reviewer must also inspect `Source Scope Resolution` before judging ownership. Primary work item requirements must remain the ownership driver. Linked/prerequisite documents may supply dependencies, precedents, compatibility constraints, existing-plan evidence, or explicitly delegated scope, but they must not become the owning domain concept or implementation scope unless the primary work item delegates that scope.

The reviewer must check:

1. What domain concept is being exposed?
2. What is the canonical source of truth for that concept?
3. Which route, service, module, table/model, package, or shared type currently owns that concept?
4. What exposed surface does the plan propose?
5. Does that surface own the concept, or is it only a consumer/convenience surface?
6. Is each new field or behavior source-of-truth, projection, convenience, compatibility shim, or temporary migration field?
7. Which consumers need the field or behavior?
8. Which consumers are intentionally not exposed to it?
9. What alternatives were rejected, especially exposing through the existing owner surface?
10. How will the projection, if any, stay consistent with the owner?
11. What tests prove the selected ownership, consumer path, and non-exposure decisions?
12. Which `REQ-*` primary requirement each API/data-model task and acceptance criterion maps to, and which supplemental `CTX-*` dependency/prerequisite/delegated-scope constraints also apply?
13. When multiple producers can write the same logical resource, which producer/write sources exist today, which are new, which owner or idempotency strategy is authoritative, and how each operation outcome is acknowledged to callers and downstream consumers?

The reviewer must also check whether:

- API/data-model ownership-sensitive work includes a Contract Ownership Decision that identifies the domain concept, canonical source of truth, current owner, proposed surface, field role, consumers, rejected alternatives, and validation (definition in `sections/planning-phase.md`)
- plans that expose new or changed related data, metadata, derived fields, or projections include an Exposure Surface Parity Matrix (definition in `sections/planning-phase.md`), covering equivalent read surfaces, caller classes, serialized shape, telemetry/log scope, runtime validation boundaries, fixture paths, included/excluded consumers, and executable parity tests
- first-class resource, lifecycle object, durable state record, or externally refreshed entity changes include a Stateful Resource Compatibility Matrix (definition in `sections/planning-phase.md`), covering required identifiers, read surfaces, write/update sources, partial/incomplete/stale updates, state preservation, nullable migration windows, and executable compatibility tests
- multi-producer persistence, sync, replay, migration, backfill, repair, or batch work includes existing and new producer inventories, authoritative owner or shared idempotency strategy, acknowledgement/result mapping, existing-data cutover behavior, and executable compatibility tests in the applicable planning matrices
- externally observed automatic resource creation, materialization, linking, claiming, or storage includes an External Observation Ownership Resolution matrix (definition in `sections/planning-phase.md`) when the event may lack the normal user-selected, work-item, route, or owner identifier; fail the plan unless it defines the primary routing identifier, deterministic fallback keys, behavior for no match, multiple matches, stale matches, nullable ownership, and partially known ownership, plus validation that proves the approved ownership outcomes at the highest existing practical boundary
- for new or changed related data, metadata, derived fields, or projections, the plan includes every equivalent read surface and caller class, included/excluded consumers, serialized shape, telemetry/log scope, raw-value validation boundary, fixture or builder path, and executable parity tests; fail the plan otherwise
- for first-class resource or durable lifecycle changes, the plan proves required identity propagation, read/write surface alignment, authoritative versus partial update sources, stale/incomplete event behavior, state-preservation rules, nullable migration-window states, and executable compatibility tests; fail the plan otherwise

## Lane Focus

- Verify each persisted field, projection field, status source, writer, reader, and external payload mapping has one named source of truth and an explicit owner.
- Verify the plan describes the current contract, target contract, owner surfaces, consumer surfaces, compatibility behavior, and validation strategy for each API/data-model change where applicable.
- Require caller inventory for shared write helpers and projection upserts, including create and update paths; fail if any caller would silently derive new state from a legacy field after the plan changes ownership.
- Require producer/write-source inventory for sync, replay, migration, backfill, repair, or batch paths; fail if old and new producers can both write the same logical resource without a named authoritative owner or shared idempotency strategy.
- For source-of-truth changes, require the plan to state how existing mixed records are measured, reconciled, or intentionally left conservative.

## Required Ownership Matrix

The reviewer must return an Ownership Matrix with:

- domain concept
- canonical source of truth
- current owner surface
- proposed exposed surface
- reviewer verdict on whether the proposed surface owns the concept or is an acceptable projection
- field role: source-of-truth, projection, convenience, compatibility shim, or temporary migration field
- consumers that need it
- consumers intentionally not exposed
- rejected alternatives and why they were rejected
- consistency and compatibility mechanism
- producer/write-source inventory and acknowledgement/result mapping, if more than one producer can write the same logical resource
- tests/validation proving ownership and consumer behavior
- repo files/call sites inspected
- verdict: `PASS` | `FAIL` | `BLOCKED`
- required correction or human/product/architecture decision

## Failure Rules

Fail the plan when it places a constant, type, or schema in a shared package with fewer than two verified current consumers from different surfaces and no plan task creating the second consumer. The consumers must be cited as Grounding Manifest grep claims with `expected_paths`; "shared by A and B" assertions without verified manifest claims are not ownership evidence, and the narrowest owning module wins instead.

Fail the plan if the chosen API, MCP, wire, shared type, route, service, module, or persisted model does not own the concept and the plan does not justify it as a projection with consistency rules and tests. Fail the plan if the plan adds convenience fields to a non-owning surface only because a consumer already calls that surface. Fail the plan if rejected alternatives are missing for plausible owner surfaces. Use `BLOCKED` only when the correct owner is a true product/architecture decision that cannot be resolved from the work item and repo context.

Fail the plan if the ownership proposal is primarily grounded in a linked/prerequisite document while the primary work item's requirements are absent, reframed, or unmapped. Fail when API/data-model tasks or acceptance criteria are not mapped to declared primary requirements in `Source Scope Resolution`, or when `CTX-*` constraints replace rather than supplement primary scope.

Fail the plan if multi-producer persistence, sync, replay, migration, backfill, repair, or batch behavior can write or acknowledge the same logical resource through old and new paths and the plan does not enumerate those producers, choose the authoritative owner or shared idempotency strategy, map operation results back to callers/downstream consumers, and define existing-data cutover behavior.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- source-scope-to-ownership mapping, including which primary requirement drives each proposed API/data-model surface and which dependency constraints are supplemental
- contract ownership decision checked, including domain concept, canonical source of truth, current owner, proposed surface, field role, consumers, rejected alternatives, and ownership validation, if API/data-model ownership-sensitive
- exposure surface parity, including equivalent read surfaces, caller classes, included/excluded consumers, serialized null/empty/default/date/status behavior, telemetry/log scope, runtime validation boundaries, fixture or builder paths, and executable parity tests, if new or changed related data, metadata, derived fields, or projections are exposed
- stateful resource compatibility, including required identifiers, ownership keys, reference/link fields, read surfaces, producer/write-source inventory, authority and source-of-truth ordering, acknowledgement/result mapping, partial/incomplete/stale update behavior, state-preservation rules, existing-data cutover behavior, nullable or compatibility-window states, and executable compatibility tests, if the plan creates, promotes, canonicalizes, or materially changes a first-class resource or durable lifecycle state
- external observation ownership resolution, including the primary routing identifier, fallback keys and priority, no-match, multiple-match, stale-match, nullable-owner, partial-owner, persistence/API/projection outcomes, and validation evidence, if automatic resource creation, materialization, linking, claiming, or storage may occur without the normal routing identifier
