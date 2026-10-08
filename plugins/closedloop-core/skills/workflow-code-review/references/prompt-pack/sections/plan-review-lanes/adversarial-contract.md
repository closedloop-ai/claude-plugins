# Adversarial Contract Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This lane reviews call-site inventory, canonicalization/signing, trust boundaries, compatibility/version skew, propagation paths, failure/replay/recovery, and exact reason/status taxonomy. For cross-repo, security-sensitive, auth/signing, API/wire-contract, persistence, replay/recovery, or compatibility-sensitive work, this lane must be substantive; it is a core lane and always runs.

## Required Checks

The reviewer must check whether:

- cross-repo contracts and backward compatibility risks are represented
- producer-to-consumer runtime paths are traced through the actual writer, transport, process cwd or `--workdir`, reader, and test coverage
- shared package, schema, generated-client, or protocol-library handoffs state whether consumers use workspace source, generated code, vendored code, or published package versions
- prompt, skill, markdown-agent, script, schema, fixture, and docs-as-runtime-instruction consumers are included in the call-site inventory when affected
- descriptor IDs, envelope fields, ordering, collision behavior, source-of-truth ordering, reason strings, status codes, and telemetry keys use an exact taxonomy instead of executor-defined names
- contract changes include executable tests, fixtures, source checks, or validation scripts rather than documentation-only examples
- mutation actions, commands, write endpoints, workflow operations, or state-changing tools include a Mutation Contract Matrix (definition in `sections/planning-phase.md`), covering caller compatibility, response and failure envelopes, target validation, read-after-write surfaces, idempotency, partial-apply behavior, structured input boundaries, and executable contract tests

## Lane Focus

- Verify trust boundaries, retryability, spoofing, authorization, external-provider failures, and abuse paths are modeled against actual code boundaries.
- For plans that combine remote provider calls and DB writes, require the remote call to be outside write transactions unless the plan gives a repo-grounded reason and timeout/retry mitigation.
- Fail this lane when retryable provider failures, webhook redelivery volume, ambiguous external state, or self-attested evidence can bypass the intended control.

## Adversarial Review Passes

For any plan touching auth, signing, canonicalization, payload verification, command dispatch, relay/gateway behavior, cross-repo contracts, compatibility, persistence, retries, replay, recovery, or externally visible API behavior, the reviewer must run these passes:

1. Canonicalization and signing pass:
   - Identify every field covered by a signature, hash, fingerprint, idempotency key, or verification payload.
   - Identify every transformation before and after signing or hashing.
   - Verify path, query, method, body, IDs, timestamps, nonces, reason strings, and encoded values cannot be mutated without detection.
   - Require tamper tests for path/query encoding, ordering, separators, trailing slashes, percent-encoding, body hash, timestamp, nonce, and replay where applicable.
2. Code contradiction pass:
   - For every plan claim like "must not rewrite", "must reject", "must preserve", "must fail", "must not fetch", or "must remain compatible", inspect current code for existing behavior that contradicts it.
   - Fail the plan unless a task explicitly removes, guards, preserves, or tests that behavior.
3. Call-site and chokepoint inventory:
   - Inventory all callers of changed helpers, routes, clients, command dispatchers, validation functions, capability checks, status/reason emitters, storage writers, and API response consumers.
   - Include tests, fixtures, scripts, CLIs, markdown agent prompts, skill files, schemas, and docs that act as runtime instructions when they consume or define the changed behavior.
   - Fail the plan if enforcement can be bypassed through another call site.
4. Cross-repo propagation pass:
   - For every new capability, payload field, response field, reason string, telemetry key, header, persisted value, mode flag, runtime-materialized file, descriptor, or shared package/schema change, trace producer -> transport -> parser/materializer -> storage/path/package/version -> consumer.
   - Pin exact file paths and whether the field is top-level, nested, optional, defaulted, or legacy-compatible.
   - For file-based contracts, pin actual write path, process cwd or `--workdir`, read path, fallback discovery behavior, and fixture coverage for the real runtime path.
   - For package/schema contracts, pin whether consumers use workspace source, generated code, vendored code, or published packages, plus the exact version/update strategy.
5. Trust boundary pass:
   - Identify any value that changes from server-controlled to client-controlled, Desktop-controlled, browser-controlled, user-controlled, or network-controlled.
   - Require validation, ownership/collision behavior, abuse/griefing behavior, and tests.
6. Failure/replay/recovery pass:
   - Model retry, restart, reconnect, clock skew, stale state, nonce/cache reset, duplicate delivery, partial delivery, and delivery failure.
   - Fail the plan if replay or recovery behavior is asserted without storage/lifetime/test details.
7. Exact taxonomy pass:
   - Reason strings, status codes, capability names, telemetry keys, error codes, descriptor IDs, source-of-truth IDs, artifact IDs, ordering rules, collision behavior, and response shapes must match exactly across acceptance criteria, plan tasks, code, and tests.
   - Fail the plan on naming drift unless the plan explicitly reconciles the taxonomy.
8. Privacy and visibility pass:
   - For any key, token, credential, identifier, user/org directory, or cross-user visibility surface, identify who can read/write/list it and why.
   - Fail the plan if visibility defaults are vague or broader than required.
9. Compatibility/version-skew pass:
   - For changes in one configured repo consumed by another configured repo, prove older or existing consumers continue to work or identify a real migration boundary.
   - For changes in a configured repo that communicates with another configured repo, prove existing producer/consumer expectations remain compatible.
   - Apply repo-specific compatibility guidance discovered from workflow memory, repo-profile cache entries, current code, and guardrails. New fields should be optional/defaulted, new enforcement should have a compatibility path, and response-shape changes should preserve older client expectations unless a migration boundary is explicit.
10. Feature-flag rollout pass:
   - Apply the Feature Flag Applicability definition from `sections/planning-phase.md`. Do not treat every API, MCP, type, test, telemetry, refactor, or compatibility change as a feature-flag candidate.
   - If `WORKFLOW_FEATURE_FLAG_REPO` is configured, for changes in that repo that introduce or materially change a user-visible capability/default, actively triggered endpoint/command/automation/integration, enforcement/auth/security/quota/validation policy, staged client/server protocol behavior, or rollout-sensitive data/background-processing path, verify the plan includes a `${WORKFLOW_FEATURE_FLAG_PROVIDER}` feature flag.
   - The plan may choose the flag name when the work item does not specify one, but it must use a concise kebab-case name and state the exact evaluation point, default-off/fallback behavior, compatibility behavior when the flag is off or missing, rollout notes, and enabled/disabled tests.
   - Fail the plan if required feature-flag coverage is missing, if an ambiguous rollout-sensitive change is silently treated as non-applicable, or if non-applicability is asserted without repo-grounded evidence.
11. Executable contract validation pass:
   - For every behavior, schema, runtime path, package handoff, descriptor taxonomy, prompt/skill behavior, or consumer migration change, verify the plan includes an executable test, fixture, source check, or validation script that would fail if the contract is wrong.
   - Fail the plan if validation is documentation-only when the behavior can be tested or source-checked.
12. Deferred-decision language pass:
   - Search for conditional handoff language such as "if needed", "where appropriate", "executor should decide", "implementation may choose", or equivalent wording.
   - Fail the plan when that language applies to package strategy, runtime paths, schema shape, file ownership, compatibility, validation, or test coverage and the repo context can resolve it.
   - If repo context cannot resolve the issue, verify it is listed as an Open Question or Gap blocker and directly reported to the user.
13. Literal contract consistency pass:
   - For database/query changes, require literal snippets or precise rules for ordering, tie-breakers, deduplication, pagination/limits, and first-row/last-row overwrite behavior. Fail the plan if English prose could let an executor drop a required tiebreaker, source-of-truth import, or reducer invariant.
   - For API/MCP/wire response-shape changes, require at least one boundary-level test or snapshot that exercises the real route/tool/shaper/envelope path. Unit tests with every downstream layer mocked are insufficient for omit-vs-null, envelope, merge, or serialization invariants.
   - For mutation actions, commands, write endpoints, workflow operations, or state-changing tools, fail the plan unless it includes a Mutation Contract Matrix covering existing and new caller compatibility, previous and new response shapes, status/error envelopes, target validation, read-after-write visibility, idempotency, partial-apply behavior, structured input boundaries, and executable contract tests.

If a pass is not applicable, the reviewer must explicitly say why. Do not skip passes silently for contract-heavy work.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- API/wire/storage contract affected, if any
- runtime file path handoff, including producer, write location, process cwd or `--workdir`, reader, and expected read location, if any
- shared package/schema/version handoff, including whether consumers use workspace source, generated code, vendored code, or published packages, if any
- prompt, skill, markdown-agent, script, schema, fixture, or docs-as-runtime-instruction consumers inspected, if any
- descriptor/envelope taxonomy checked, including IDs, ordering, collision behavior, and source-of-truth ordering, if any
- backward-compatibility impact, including producer/consumer relationships discovered from current repo evidence, workflow memory, repo-profile cache entries, and guardrails
- mutation contract coverage, including existing and new callers, previous and new response shapes, status/error envelopes, target and ownership validation, read-after-write surfaces, idempotency/retry/conflict/no-op behavior, partial-apply or compensation behavior, structured input boundary cases, and executable compatibility tests, if mutation actions or state-changing operations are added or changed
