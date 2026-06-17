# Behavioral Edge-Case Expansion

For each intended row, run this expansion pass. Every category must be represented by rows or an explicit non-applicability note with source-backed evidence before marking `Final Alignment Status: Aligned`.

Where a category lists test invariants, the test must prove the specific binding/fallback/diagnostic the row claims, not just trigger a generic rejection.

Disposition standards:

- `Covered` or `already covered` requires a named test plus the wrong-input or negative case that test fails closed on.
- `Not applicable` requires source-backed evidence, such as grep output, export/package inventory, call-site inventory, schema/query inventory, or exact code references proving the surface is absent or out of scope.
- Coverage for a CLI, route handler, package export, worker/job, replay path, ingest pipeline, attribution pipeline, or public API requires a test through that real boundary. A pure helper test only covers helper-local invariants unless paired with a real-boundary test proving production wiring.

## Structured-result contracts

Include rows for synchronous preparation failures before fetch/await/return: URL construction, payload building, JSON/body/header construction, parser setup, and other throw-capable setup code.

## Exported boundary invariants

When a helper, service, adapter, route, command, job, or handler can be called by more than one path, include rows for the invariants it must enforce itself even when current callers validate first, especially before network I/O, persistence, credentials, filesystem mutation, or other durable side effects. Do not rely only on caller-side validation: either the boundary enforces its own invariants, or record why it is intentionally private/single-caller and how that is kept true.

## Contract-signal precedence

When a dependency or peer returns multiple signals affecting the same decision (transport status, structured body fields, error codes, reason strings, headers, metadata, exit status, sentinel files), include rows for each signal and for conflicts between signals. State which signal wins and how unknown/missing signals degrade. Cover transport-vs-payload conflicts, older peers omitting newer fields, and newer peers sending unknown values.

For ORM or database errors whose metadata shape varies by adapter or version, include every documented shape that drives the branch, such as constraint-name strings, field-name arrays, column-name arrays, missing metadata, and unrelated constraint metadata. Tests must prove the intended mapping for each accepted shape and the fallback for unrelated shapes.

## External contract literal binding

When behavior depends on a literal string or key outside the immediate helper, inventory the exact literal and classify its semantic type before implementation. This includes feature flag keys, rollout names, query parameters, route paths, header names, cache key segments, storage keys, environment variables, telemetry event names, command names, plugin identifiers, marketplace identifiers, version labels, URL schemes, and reason/status strings.

Include rows for the exact configured literal, absent or disabled literal, wrong but similar literal, legacy/old literal when compatibility is required, and unrelated internal labels that must not be accepted as the external contract. State the source of truth for each literal: plan or PRD text, repo constant, existing API contract, rollout configuration, documented client behavior, or user-provided deployment fact.

**Tests:** require a positive exact-key case and at least one wrong-key or same-looking-key mutation. Mocks must fail closed: do not return enabled, valid, found, or accepted for arbitrary keys. For feature flags, enable only the expected key; for query/header/event/storage/cache/command/plugin identifiers, assert the exact key or name and its semantic role.

## Published contract compatibility

When the change touches a package export, package subpath, CLI command or flag, public route, shared type, output field, artifact schema, registry/marketplace metadata, persisted artifact, or documented integration contract, include rows for current consumers, old typed consumers, old serialized artifacts, legacy subpaths or aliases, missing newly required fields, unknown newly produced fields, and compatibility shims or explicit break decisions.

Record evidence from package/export metadata, call-site or import greps, docs or registry metadata, and legacy artifact read paths. Do not assert "no consumers" or "not published" without evidence.

**Tests:** require a current-shape positive case and at least one old/legacy/missing-field case when compatibility is required by repo guardrails or existing contracts. If a compatibility shim is intentionally absent, record the product or guardrail source that permits the break.

## CLI and flag parsing robustness

When behavior depends on a command-line flag, option, environment-style argument, or slash-command parameter, include rows for absent flag, valueless flag, explicit empty value, `0`, invalid number/string, repeated flag, unknown flag, negative value where applicable, `--flag=value`, `--flag value`, and positional-argument ambiguity. State which parser owns validation, which layer emits diagnostics, and whether defaults are applied before or after validation.

**Tests:** require coverage through the real command boundary for valid input, valueless input, `0` or explicit empty input when semantically distinct, and at least one invalid value. Helper parser tests can supplement but cannot replace the boundary test when the CLI or command behavior is the external contract.

## Library-managed lifecycle re-entry

Include rows for automatic reconnects, retry timers, callbacks, restarts, framework-owned replays, and other paths that re-enter with reused state.

## Active-processing re-entry

When a flow can receive a new event/request/callback/file/message/retry while an earlier item is still being handled, include rows for idle, active, queued, coalesced, duplicate, dropped, and shutdown states. State when pending work drains and whether callers see a retryable, terminal, or silent outcome.

**Tests:** require an idle path, an active-processing path, and a drain or terminal-outcome assertion when the implementation queues, coalesces, deduplicates, drops, or rejects repeated work.

## State propagation across isolation boundaries

When one phase computes, validates, or mutates state inside an isolated execution context and a later phase depends on that state, include rows for how the state crosses the boundary. Isolation contexts include subprocesses, workers, job steps, containers, sandboxes, transactions, callbacks, closures, remote commands, child tasks, separate event loops, and separate requests. State whether each required value is returned, emitted, persisted, recomputed in the parent/consumer, passed through an explicit output channel, or intentionally unavailable after the boundary exits.

Include rows for success, validation failure, dependency failure, cancellation/timeout, and partial-output branches. For each branch, state which later side effects must still see the value, which must not run without it, and how missing or stale propagated state is classified.

**Tests:** require at least one test that exercises the real production sequencing across the boundary, not only direct helper calls in a shared context. The test must prove the later phase receives the expected value, rejects the missing value, or records the intended fallback.

## Cross-surface propagation and reconciliation

When a write affects multiple processes, replicas, apps, windows, stores, or peers, include rows for how every affected surface learns about the write. Cover immediate push/control events, polling, heartbeat, reconnect, startup, manual refresh, missed event, offline recovery, and the durable source of truth that wins when surfaces disagree.

For distributed browser-command, key, authorization, or signing workflows, model the web app, backend, Electron process, local trusted-key store, OS notification layer, command dispatcher, and remote peer separately unless implementation proves two surfaces share the same state and lifecycle.

**Tests:** require at least one immediate propagation assertion and one delayed or missed-event reconciliation assertion. The test must prove the affected consumer changed behavior, not only that the source write succeeded.

## Data visibility versus side effects

When a state change should both become visible and trigger an effect, include separate rows for the data becoming listable/readable and for each side effect firing, deduplicating, retrying, or intentionally not firing. Side effects include OS notifications, telemetry, command dispatch, revocation dispatch, cleanup, acknowledgement, badge/count updates, and user prompts.

Refreshing a list, cache, or view proves only data visibility unless the row and test also assert the side effect. Include rows for duplicate refreshes, repeated events, stale views, and already-notified/already-dispatched state.

**Tests:** require independent assertions for the visible data state and the side-effect state when both are externally visible or operationally important.

## Cached capability drift

When command routing, revocation, authorization, feature availability, or safety behavior depends on cached peer capabilities or supported operations, include rows for fresh cache, stale false negative, stale false positive, old peer with no capability signal, unknown peer shape, cache miss, retry, fallback, and reconciliation after the peer reports authoritative capability.

Do not let a stale false negative silently skip a safety-critical command when retry, fallback dispatch, source-of-truth lookup, or later reconciliation is required. Do not let a stale false positive produce an unrecoverable command failure when an old peer or downgraded peer should degrade safely.

**Tests:** require one stale false-negative case, one stale false-positive or old-peer case, and one reconciliation case that proves the cache is corrected or bypassed according to the intended behavior.

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

## Durable finalization and replay eligibility

When a flow writes local terminal state and separately posts, uploads, acknowledges, or finalizes external terminal state, include rows for: before local terminal persistence, after local persistence but before external acknowledgement, retryable external failure, non-retryable external failure, successful external acknowledgement, and recovery/replay after restart.

State which durable fields make the item eligible or ineligible for recovery, which credentials, tokens, signatures, secrets, locks, or marker data must be retained until acknowledgement, which cleanup runs only after acknowledgement, and whether replay emits the same user-visible status, code, message, result, diagnostics, and warning semantics as the live path.

**Tests:** require at least one retryable external failure after local terminal persistence, one successful acknowledgement cleanup path, and one recovery/replay assertion that proves the same terminal user-visible outcome is posted.

## Shared durable resources

When deleting, rotating, revoking, or clearing persisted keys, credentials, locks, cache entries, files, profiles, identities, or other durable resources, include rows for: no remaining references, another saved/profile reference, active runtime reference, stale reference, and unknown lookup failure. State whether the resource is reference-counted, ownership-scoped, shared, or safe to delete unconditionally.

## Filesystem read/write safety

When a flow reads from or writes to a user-provided, plan-provided, derived, downloaded, unpacked, or persisted path, include rows for raw input, normalized path, canonical/resolved path, parent traversal, symlink target, existing file, existing directory, missing parent, permissions failure, clobber/overwrite behavior, partial write, cleanup after write failure, unbounded or unexpectedly large reads, and race conditions between validation and use.

State whether writes are atomic, whether existing files may be overwritten, whether symlinks are followed or rejected, which root or ownership boundary is enforced, and how canonical values are persisted or reported. For output paths, include explicit rows for `--out` or equivalent destinations when present.

**Tests:** require a safe positive path, a blocked traversal or out-of-root path, and at least one symlink/clobber/bounded-read mutation when the platform and test harness can model it. If a mutation is impossible to test, record the source-backed reason in `Evidence Artifacts`.

## Profile or config cloning

When saving, duplicating, importing, switching, or snapshotting a profile/config from active runtime state, include rows for fields that must be copied, regenerated, omitted, or downgraded. Treat credentials, signing keys, service IDs, device IDs, integration IDs, public keys, machine identities, and other ownership-scoped identifiers as non-transferable by default unless the plan explicitly says they are shared.

Final verification must prove a new profile/config cannot accidentally inherit another profile's ownership-scoped identity or credential binding.

## Backward-compatible persisted defaults and promotion

When older persisted records lack new provenance, source, trust, ownership, capability, or lifecycle fields, include rows for missing fields, explicit legacy values, conservative defaults, authoritative evidence that allows promotion/backfill, authoritative evidence that requires downgrade or revocation, and mixed old/new records.

Promotion or backfill must require source-backed evidence from a durable authority or verified peer signal. Include rows proving manual, locally trusted, or user-created records are not accidentally deleted, promoted to managed state, or treated as remotely revocable without that evidence.

**Tests:** require at least one legacy missing-field case, one evidence-backed promotion or backfill case, and one manual or legacy record that must remain conservative.

## Distributed lifecycle coverage

For distributed command, browser-key, authorization, signing, or peer-trust workflows, include lifecycle rows for register/create, approval/authorization, normal command execution, revoke/delete, offline/reconnect reconciliation, repeated action/idempotency, and stale UI/cache behavior.

Each lifecycle row must identify the initiating surface, durable source of truth, affected replicas, expected side effects, idempotency key or dedupe rule when applicable, and recovery behavior after missed events or stale local state.

**Tests:** require coverage for creation/registration, authorization, normal command or use, revocation/deletion, and at least one offline/reconnect or stale-cache reconciliation path.

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

When an upsert or partial update triggers a derivation, reducer, stamped field, or validation, that computation must consume the post-merge result (existing state union patch), not the incoming patch alone. A derivation that reads only the incoming patch sees an undefined or stale value for any field the patch omits, so include a row stating that the derivation reads merged state and which fields it depends on.

**Tests:** require a single-field or partial-update test row proving the derivation reads merged state, for example a patch that omits an identity or state field the derivation depends on, and assert the derived value reflects the merged record rather than the incoming patch.

## Persistence access paths

When adding persisted fields, tables, indexes, uniqueness constraints, or cleanup jobs, inventory the actual reads, writes, filters, sort orders, expiry scans, rate limits, and ownership checks that will use them. Distinguish query-critical indexes from write-only metadata, future-only fields, redundant left-prefix indexes, and indexes that need additional columns to match the real predicate. Remove or mark not-applicable any index not justified by a current query, rate limit, cleanup path, uniqueness guarantee, sort order, or documented near-term requirement.

For new uniqueness constraints or stricter persisted invariants on existing tables, include rows for the current-data migration path: no violating rows, existing duplicate/invalid rows, cleanup or backfill behavior, explicit preflight failure when cleanup is not safe, and writes racing with the migration where applicable. Do not assume old app-level validation made invalid persisted states impossible when the new constraint closes a race.

When cleanup or backfill changes persisted identity fields to satisfy a new invariant, also model the adjacent constraints, references, preferences, and first normal application write that will reconcile the cleaned rows. The migration must not leave stale rows in a state where the next legitimate update, registration, retry, or recovery path fails on a different constraint than the one being introduced.

## Side-effect boundary

For every validation or preparation failure, state whether network calls, persistence, key generation, retries, telemetry, or other durable side effects should happen.

## Testable invariant

For signing, canonicalization, validation, and compatibility rows, state the exact invariant a test must prove, including a positive control and one-axis mutation when a field binding matters.

For retry or recovery tests, require a positive retryable case, a terminal/non-retryable case, and an unknown-or-legacy-shape case when the contract supports partial or version-skewed peers.
