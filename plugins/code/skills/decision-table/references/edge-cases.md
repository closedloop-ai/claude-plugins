# Behavioral Edge-Case Expansion

For each intended row, run this expansion pass. Every category must be represented by rows or an explicit non-applicability note before marking `Final Alignment Status: Aligned`.

Where a category lists test invariants, the test must prove the specific binding/fallback/diagnostic the row claims, not just trigger a generic rejection.

## Structured-result contracts

Include rows for synchronous preparation failures before fetch/await/return: URL construction, payload building, JSON/body/header construction, parser setup, and other throw-capable setup code.

## Exported boundary invariants

When a helper, service, adapter, route, command, job, or handler can be called by more than one path, include rows for the invariants it must enforce itself even when current callers validate first, especially before network I/O, persistence, credentials, filesystem mutation, or other durable side effects. Do not rely only on caller-side validation: either the boundary enforces its own invariants, or record why it is intentionally private/single-caller and how that is kept true.

## Contract-signal precedence

When a dependency or peer returns multiple signals affecting the same decision (transport status, structured body fields, error codes, reason strings, headers, metadata, exit status, sentinel files), include rows for each signal and for conflicts between signals. State which signal wins and how unknown/missing signals degrade. Cover transport-vs-payload conflicts, older peers omitting newer fields, and newer peers sending unknown values.

For ORM or database errors whose metadata shape varies by adapter or version, include every documented shape that drives the branch, such as constraint-name strings, field-name arrays, column-name arrays, missing metadata, and unrelated constraint metadata. Tests must prove the intended mapping for each accepted shape and the fallback for unrelated shapes.

## Library-managed lifecycle re-entry

Include rows for automatic reconnects, retry timers, callbacks, restarts, framework-owned replays, and other paths that re-enter with reused state.

## Active-processing re-entry

When a flow can receive a new event/request/callback/file/message/retry while an earlier item is still being handled, include rows for idle, active, queued, coalesced, duplicate, dropped, and shutdown states. State when pending work drains and whether callers see a retryable, terminal, or silent outcome.

**Tests:** require an idle path, an active-processing path, and a drain or terminal-outcome assertion when the implementation queues, coalesces, deduplicates, drops, or rejects repeated work.

## State propagation across isolation boundaries

When one phase computes, validates, or mutates state inside an isolated execution context and a later phase depends on that state, include rows for how the state crosses the boundary. Isolation contexts include subprocesses, workers, job steps, containers, sandboxes, transactions, callbacks, closures, remote commands, child tasks, separate event loops, and separate requests. State whether each required value is returned, emitted, persisted, recomputed in the parent/consumer, passed through an explicit output channel, or intentionally unavailable after the boundary exits.

Include rows for success, validation failure, dependency failure, cancellation/timeout, and partial-output branches. For each branch, state which later side effects must still see the value, which must not run without it, and how missing or stale propagated state is classified.

**Tests:** require at least one test that exercises the real production sequencing across the boundary, not only direct helper calls in a shared context. The test must prove the later phase receives the expected value, rejects the missing value, or records the intended fallback.

## Terminal-state transition guards

When a flow has terminal/one-way states (approved, denied, expired, consumed, completed, cancelled, revoked, failed), include rows for every mutating action attempted from each terminal state. State which states are mutable, which are no-ops, which return a terminal error, and which durable fields must never be rewritten. Include repeated UI actions (approve-then-deny, deny-then-approve, double-clicks, retries after timeout, stale browser tabs after another actor completed the flow).

Final verification must prove terminal states cannot be overwritten by later actions unless the intended table explicitly allows a rollback or superseding transition.

## Cancellation and shutdown

When a flow waits, sleeps, backs off, schedules a timer, retries, or runs asynchronously, include rows for cancellation/shutdown before the wait, during the wait, after the wait but before the next side effect, and during the side effect when applicable.

## Finalizer-visible cleanup state

When cleanup runs through a deferred finalizer, trap, disposer, signal handler, process-exit hook, framework cleanup callback, or language cleanup block, include rows for the state available at cleanup execution time. State where cleanup handles, mounted resources, temp paths, locks, subscriptions, transactions, or staged artifacts are stored; which scopes can see them when cleanup executes; when each handle is cleared; and what happens if the main flow exits through an error helper, early return, cancellation, signal, or raised/rejected failure branch.

**Tests:** require at least one failure path that exits through the real finalizer mechanism after cleanup state is populated, proving the intended cleanup action runs. A happy-path cleanup assertion alone is not enough.

## Time-bound credentials, signatures, or payloads

Include rows for first attempt, retry/reconnect, restart, expired past timestamps, future timestamps, and clock-boundary conditions. State whether timestamped or expiring material is regenerated, rejected, or reused. Require both stale/too-old and future/too-new rows unless future values are impossible by construction and that construction is documented.

## One-time side effects

When a flow deletes, consumes, rotates, invalidates, acknowledges, commits, uploads, locks, or otherwise spends a one-time resource, include rows for failures and re-entry before and after that side effect. Include cleanup/consume failures on success, validation failure, parse failure, and dependency failure branches when those branches attempt cleanup. State whether the resource can be safely reused, retried, replaced, or must be considered spent.

Require parity rows for invalid and dependency-failure branches, not only valid or happy-path branches.

## Shared durable resources

When deleting, rotating, revoking, or clearing persisted keys, credentials, locks, cache entries, files, profiles, identities, or other durable resources, include rows for: no remaining references, another saved/profile reference, active runtime reference, stale reference, and unknown lookup failure. State whether the resource is reference-counted, ownership-scoped, shared, or safe to delete unconditionally.

## Profile or config cloning

When saving, duplicating, importing, switching, or snapshotting a profile/config from active runtime state, include rows for fields that must be copied, regenerated, omitted, or downgraded. Treat credentials, signing keys, service IDs, device IDs, integration IDs, public keys, machine identities, and other ownership-scoped identifiers as non-transferable by default unless the plan explicitly says they are shared.

Final verification must prove a new profile/config cannot accidentally inherit another profile's ownership-scoped identity or credential binding.

## Diagnostic contracts

When the plan requires redacted diagnostics, telemetry, or structured reasons, include expected reason/category values for each failure class: validation failure, missing state, unavailable secure storage, signer failure, timeout, network failure, remote rejection.

## Advertised status inventory

When code exposes statuses, reasons, modes, variants, exit values, event names, or other enumerated outcomes, inventory which branches produce each value and flag dead, unreachable, duplicated, or misleading values. Every advertised value must be produced by some branch; every produced value must be documented by the table.

## Exception scope

For route handlers, middleware, auth wrappers, and policy helpers, distinguish setup failures, auth/proof failures, database/lookup failures, and downstream handler failures so catch-all blocks do not collapse unrelated errors into the same external status or message.

## Serverless async side effects

For serverless or edge route handlers, include rows for side effects after the response path: last-used timestamps, telemetry, uploads, notifications, cleanup. State whether they are awaited, passed to a platform lifecycle primitive (e.g., `waitUntil`), persisted through an outbox, or intentionally best-effort. Do not treat fire-and-forget promises as durable.

## Path and identity policy canonicalization

For allowlists, denylists, ownership checks, cache keys, dedupe keys, lock keys, object identifiers, and other policy comparisons, include rows for raw input, normalized form, canonical form, aliases, symbolic references, case/separator variants, parent/child boundaries, empty values, and missing targets where applicable.

**Tests:** require a safe positive control, a blocked canonical control, and at least one equivalent or near-equivalent mutation that could bypass naive string comparison.

## Transformed input validation parity

When a flow trims, parses, decodes, normalizes, canonicalizes, defaults, coerces, or otherwise transforms input from a user, dependency, file, message, request, or environment before a decision or side effect, include rows for the raw input, transformed value, validation target, and final consumed value. State whether validation is intentionally applied before or after transformation, and ensure rejection/acceptance messages match the value actually used. This applies even when the transformed value is not durable.

**Tests:** require at least one mutation where transformation removes harmless input (for example leading/trailing whitespace) and one mutation where invalid content remains after transformation, proving validation accepts/rejects based on the final consumed value rather than an unrelated raw spelling.

## Canonical value persistence

When a validated path, identity, endpoint, workspace, profile, tenant, account, or other policy-bearing value is later written to a durable message, handoff, configuration, state record, command, or file, include rows proving the persisted value is the same canonical value that was validated. Distinguish raw input, expanded input, normalized input, canonical/resolved input, and serialized output. If raw spelling is intentionally preserved for display, keep it separate from the value consumed for policy or execution.

**Tests:** require at least one alternate spelling such as a relative path, parent segment, alias, case/separator variant, or symbolic reference where applicable, and assert that durable output contains the canonical validated value rather than the raw input.

## Partial update preservation

When a route or service updates a nested object, JSON blob, configuration record, metadata map, or persisted state bundle, include rows for omitted fields, explicit empty/null fields, single-field updates, and full replacement. State whether the operation merges with existing state or replaces it, and which existing fields must survive unknown or partial updates.

## Persistence access paths

When adding persisted fields, tables, indexes, uniqueness constraints, or cleanup jobs, inventory the actual reads, writes, filters, sort orders, expiry scans, rate limits, and ownership checks that will use them. Distinguish query-critical indexes from write-only metadata, future-only fields, redundant left-prefix indexes, and indexes that need additional columns to match the real predicate. Remove or mark not-applicable any index not justified by a current query, rate limit, cleanup path, uniqueness guarantee, sort order, or documented near-term requirement.

For new uniqueness constraints or stricter persisted invariants on existing tables, include rows for the current-data migration path: no violating rows, existing duplicate/invalid rows, cleanup or backfill behavior, explicit preflight failure when cleanup is not safe, and writes racing with the migration where applicable. Do not assume old app-level validation made invalid persisted states impossible when the new constraint closes a race.

## Side-effect boundary

For every validation or preparation failure, state whether network calls, persistence, key generation, retries, telemetry, or other durable side effects should happen.

## Testable invariant

For signing, canonicalization, validation, and compatibility rows, state the exact invariant a test must prove, including a positive control and one-axis mutation when a field binding matters.

For retry or recovery tests, require a positive retryable case, a terminal/non-retryable case, and an unknown-or-legacy-shape case when the contract supports partial or version-skewed peers.
