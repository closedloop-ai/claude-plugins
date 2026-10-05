# Database/Migration Safety Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This lane reviews whether ORM schema, migrations, raw SQL, constraints, indexes, foreign keys, generated clients/types, backfills, and drift validation are planned safely and in sync. This is separate from executor-readiness, API/Data-Model Ownership, adversarial contract, and security-abuse review. It must not implement fixes. Do not rely on the API/Data-Model Ownership lane as a substitute for database migration safety.

## Applicability

Database/migration-sensitive work includes any work touching:

- ORM schema files, database schema files, generated database clients/types, migrations, raw SQL, seed data, backfills, or migration scripts
- persisted tables, columns, indexes, unique constraints, foreign keys, relation definitions, defaults, enums, triggers, extensions, or row-level security
- persisted data consumed by routes, projections, tools, clients, renderers, jobs, or analytics
- hand-authored or post-edited migration SQL, including constraint/index/FK naming
- source-of-truth moves, sync/replay cutovers, producer transitions, or existing-data repairs where old and new write paths can coexist

For such work, this lane must be substantive. If applicability is unclear, the lane must return a substantive finding or blocker rather than `not_applicable`. This lane is never planner-declarable: it always runs on a first full plan review, planning cannot skip this lane, and only this lane itself may return `not_applicable` with concrete repo/work-item evidence.

## Required Checks

The reviewer must inspect the work item, generated plan, repo guardrails, ORM schema, migration files, raw SQL, generated database clients/types, affected persisted models, and repo-supported migration validation commands needed to answer:

> Will the migration-produced database match the ORM/schema expectations and remain safe for existing data and downstream consumers?

The reviewer must check:

1. Which schema/model files, migration files, raw SQL files, generated clients/types, seed/backfill scripts, and persisted tables are touched.
2. Whether each migration is generated, hand-authored, or edited after generation.
3. Whether any hand-authored or edited SQL is justified by repo constraints and preserves ORM expectations.
4. Whether every table, column, index, unique constraint, foreign key, relation, default, enum, trigger, extension, and generated type affected by the plan is named and ordered precisely.
5. Whether constraint, index, and foreign-key names match what the ORM expects from schema metadata, or are explicitly mapped in the schema.
6. Whether migration application/deploy validation and ORM drift validation are both required and named with repo-supported commands.
7. Whether a shadow-database drift check or equivalent is available for ORM-managed schemas. For Prisma-style repos, this means the repo-supported equivalent of `prisma migrate dev` or another command that compares migration history against `schema.prisma`.
8. Whether pre-existing data can violate new constraints or uniqueness, and whether the plan includes duplicate/null/orphan checks, cleanup/backfill, or a blocker.
9. Whether rollback, destructive-change boundaries, idempotency, and backfill rerun behavior are defined.
10. Whether rows written by legacy producers, rows already written by new producers, partially migrated rows, and mixed-version coexistence are measured, reconciled, or intentionally left conservative.
11. Whether persisted data consumed by routes, projections, tools, clients, renderers, or jobs has post-migration validation at the highest existing practical boundary.

The reviewer must also check whether:

- database/migration-sensitive work includes a Database/Migration Safety decision under `sections/planning-phase.md`, including migration provenance, hand-authored SQL rationale, ORM expected constraint/index/FK names, drift validation, apply/deploy validation, rollback/backfill/idempotency, and downstream validation
- ORM-managed schema changes do not use deploy/apply-only validation as the sole proof. The plan must require the repo-supported equivalent of a shadow-database drift check when available, or surface an Open Question/GAP blocker.
- storage source-of-truth changes are not incorrectly modeled as user/org feature rollouts when user-facing behavior is unchanged (Storage Source-Of-Truth Changes definition in `sections/planning-phase.md`)
- feature flags, org toggles, dual writes, shadow writes, and dual reads do not create split-brain ownership without idempotency, reconciliation, rollback, observability, and cleanup criteria
- backend-only storage migrations prefer explicit cutover/backfill/compatibility plans over customer-visible toggles unless per-org rollout is explicitly required
- migrations, projection cutovers, compatibility backfills, source-of-truth moves, old/new path coexistence, or batch repairs include a Cutover, Backfill, And Compatibility Matrix (definition in `sections/planning-phase.md`), covering phase ownership, scoped backfill eligibility, complete iteration, retry/idempotency, tombstones, ambiguous matches, mixed-version compatibility, guardrail coverage, and executable cutover tests; fail the plan otherwise
- migrations that change persisted shapes consumed by routes, projections, tools, clients, or renderers require post-migration smoke or route/projection validation against realistic legacy or migrated data using existing repo infrastructure, or explain why no such infrastructure exists and specify the next-best validation
- source-of-truth moves, producer transitions, sync/replay cutovers, and compatibility backfills include setup-aware validation commands that can exercise legacy-produced data, newly produced data, duplicate/replayed input, and mixed existing rows against the actual package or database setup required by the repo

## Lane Focus

- Verify DDL, backfills, projections, and source-of-truth changes are safe for existing records and current read paths.
- When behavior changes how existing rows are interpreted, require a measured divergent-row/count query or a concrete reason the population cannot be measured before implementation.
- Fail this lane if the plan says no backfill or no migration while allowing existing persisted rows to flip externally visible state without quantified owner acceptance.
- Fail this lane if cutover safety depends on an acknowledgement or idempotency result that the plan does not map back to callers, jobs, downstream consumers, or retry/replay paths.

## Required Database/Migration Safety Matrix

The reviewer must return a Database/Migration Safety Matrix with:

- affected schema/model files
- affected migration/raw SQL/generated-client files
- migration provenance: generated, hand-authored, edited generated SQL, or unknown
- affected tables/columns/indexes/constraints/FKs/enums/defaults
- ORM expected names and mapping evidence for constraints, indexes, and FKs
- pre-existing-data risk and planned check/backfill/cleanup
- mixed existing-row and producer-version coexistence handling
- deploy/apply validation command
- shadow/drift validation command, or blocker if none exists
- downstream post-migration validation command
- rollback/idempotency/destructive-change boundary
- repo files and guardrails inspected
- verdict: `PASS` | `FAIL` | `BLOCKED`
- required correction or human/database decision

## Failure Rules

Fail the plan if ORM-managed schema changes rely only on migration application/deploy success. Apply/deploy commands prove the SQL can run; they do not prove that ORM schema metadata, generated clients/types, relation names, constraint names, or future local migration drift checks will match. Fail the plan if hand-authored SQL names constraints, indexes, or FKs without proving they match ORM expectations or explicit schema mappings. Use `BLOCKED` when the repo lacks a safe local drift-check path and human acceptance is required before execution.

Fail the plan if a migration, source-of-truth move, producer transition, compatibility backfill, or sync/replay cutover can encounter pre-existing or mixed-version rows and the plan omits scoped measurement, backfill/repair eligibility, idempotent rerun behavior, acknowledgement/result mapping, or setup-aware validation commands for those rows.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- database/migration safety checked, including schema/migration files, raw SQL provenance, ORM expected constraint/index/FK names, drift-check command, deploy/apply command, rollback/backfill/idempotency, pre-existing-data checks, and downstream post-migration validation, if any
- cutover, backfill, and compatibility coverage, including current path, new path, coexistence window, phase owner, rollback and cleanup criteria, scoped backfill eligibility, old-producer rows, new-producer rows, mixed-version rows, orphan/stale/deleted/tombstone handling, pagination or complete-iteration proof, retry/idempotency behavior, acknowledgement/result mapping, ambiguous-match handling, mixed-version compatibility, guardrail coverage, and executable cutover tests, if any migration, projection cutover, source-of-truth move, compatibility backfill, or batch repair is planned
