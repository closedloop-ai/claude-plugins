# Security-Abuse Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This lane performs a focused AppSec-style plan review of attacker capability, authorization, tenant/user/org isolation, untrusted input, data exposure, injection/path/URL abuse, secret leakage, telemetry/log privacy, denial of service, supply-chain/update risk, and negative/abuse-case tests. This is separate from the adversarial contract review. It must not implement fixes.

## Applicability

Security-abuse-sensitive work includes any work touching:

- API, MCP, GraphQL, webhook, gateway, relay, socket, or externally reachable response/request shapes
- auth, authorization, permissions, signing, tokens, keys, sessions, identity, org/user/project boundaries, or cross-user visibility
- tool execution, command execution, code execution, shell/script invocation, plugin/skill/judge execution, installers, updates, or dependency/package loading
- file upload/download, archive extraction, path handling, runtime-materialized files, attachments, artifacts, logs, telemetry, or persisted data that may contain user/project/org content
- URL parsing/fetching, redirects, SSRF-adjacent surfaces, browser/client-provided URLs, desktop/browser/server trust boundaries, or network egress
- payload size, rate limit, retry/replay, queue, cache, or persistence behavior that could create denial-of-service, stale authorization, replay, or data-retention issues

For such work, this lane must be substantive. The lane may return `not_applicable` for purely presentational UI, docs-only, test-only, or internal refactor work with no changed trust boundary, externally reachable behavior, persisted data behavior, dependency/update path, or untrusted input path. If applicability is unclear, it must return a substantive finding or blocker rather than `not_applicable`. This lane is never planner-declarable: it always runs on a first full plan review, planning cannot skip this lane, and only this lane itself may return `not_applicable` with concrete repo/work-item evidence.

## Required Checks

The security-abuse reviewer must inspect the work item, generated plan, repo guardrails, relevant code paths, existing tests, and any cross-repo contracts needed to answer:

1. Who can trigger the new or changed behavior?
2. What trust boundary is crossed?
3. What attacker-controlled input is accepted?
4. What data, command, file, token, key, identity, permission, URL, package, process, or persisted state could be affected?
5. What abuse path is possible if the plan is implemented as written?
6. What mitigation does the plan require?
7. What negative or abuse-case tests prove the mitigation?

The security-abuse reviewer must check, when applicable:

- authorization, RBAC, ownership, tenant/org/user/project isolation, and confused-deputy risks
- data exposure through response bodies, logs, telemetry, artifacts, PR text, uploaded files, errors, and debug output
- command injection, argument injection, path traversal, archive extraction, unsafe file writes, unsafe deletion, and symlink/race risks
- SSRF, unsafe redirects, URL allowlists, hostname/IP canonicalization, and network egress controls
- prompt/tool/MCP injection, unsafe tool argument propagation, and untrusted content influencing privileged actions
- replay, stale authorization, nonce/cache lifetime, duplicate delivery, retry abuse, and idempotency collisions
- payload-size, rate-limit, fanout, queue, recursion, regex/parser, or memory/CPU denial-of-service risks
- secret/key/token generation, storage, display, rotation, revocation, and logging behavior
- supply-chain or update risks, including package source, version pinning, installer/update execution, plugin loading, and verification
- legacy-client compatibility paths that could accidentally bypass new security enforcement

The reviewer must also check whether security-abuse-sensitive work has an explicit security-abuse review in the plan with attacker capability, abuse paths, mitigations, and negative tests.

## Lane Focus

- Verify trust boundaries, retryability, spoofing, authorization, external-provider failures, and abuse paths are modeled against actual code boundaries.
- For plans that combine remote provider calls and DB writes, require the remote call to be outside write transactions unless the plan gives a repo-grounded reason and timeout/retry mitigation.
- Fail this lane when retryable provider failures, webhook redelivery volume, ambiguous external state, or self-attested evidence can bypass the intended control.

## Required Security Abuse Matrix

The security-abuse reviewer must return a Security Abuse Matrix with:

- security surface
- attacker capability
- trust boundary crossed
- affected asset or data
- abuse path
- plan mitigation
- required negative/abuse-case test
- repo files/call sites inspected
- verdict: `PASS` | `FAIL` | `BLOCKED`
- required correction or human/security decision

The matrix must also include these rows when applicable:

- Quantitative Bounds row: for any limit, quota, cap, count, size, or fanout the plan relies on, state the limit, the cardinality it bounds, the worst-case aggregate (limit times cardinality, or the equivalent product the design permits), and the behavior at limit+1. Fail when an aggregate bound is unanalyzed or the limit+1 behavior is unspecified. A per-item limit with no aggregate analysis is a finding.
- Design-Safety Invariants row: enumerate the currently-true properties the design depends on (for example an excluded format, a forbidden change, a guaranteed-absent input, or an assumed-constant configuration). Each invariant needs either a guard test that fails if the invariant is broken, or an explicitly accepted risk with a repo-grounded reason no guard is feasible. Fail when a load-bearing invariant has neither a guard test nor an accepted-risk justification.

## Isolation Predicate Evidence

For every tenant, org, user, or project isolation row in the Security Abuse Matrix, the lane's evidence JSONL must pin the exact predicate. The final lane-evidence event includes an `isolationPredicates` field that is either an array of `{"predicate": "<exact code expression that enforces isolation>", "verifiedCallSite": "<repo-relative path and symbol where that predicate already runs>"}` or the string `"not_applicable"` with a sibling `isolationPredicatesReason` explaining why no isolation predicate applies (for example no tenant/org/user boundary is crossed). Vague-but-correct authorization prose such as "scoped to the user" is not sufficient; the predicate must be the actual expression and the call site must already exist in the repo at the pinned sha. The CLI rejects security-abuse lane ingestion when `isolationPredicates` is missing or malformed (fail closed), so the reviewer must supply it on every security-abuse lane run.

## Failure Rules

Fail the plan if a plausible repo-local security abuse path is not mitigated, if negative tests are missing for security-sensitive behavior, or if the plan leaves authorization, isolation, validation, secret handling, tool execution, URL/path handling, or abuse mitigation to the execution agent. Use `BLOCKED` only for true human/product/security decisions that cannot be resolved from the work item and repo context.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- security-abuse surface, attacker capability, abuse path, mitigation, and negative/abuse-case validation, if security-abuse-sensitive
- isolation predicate evidence (exact predicate expression plus existing verified call site) for every tenant/org/user/project isolation row, or `not_applicable` with reason
- quantitative bounds (limit, cardinality, worst-case aggregate, behavior at limit+1) for every limit/quota/cap the plan relies on
- design-safety invariants (each currently-true property the design depends on, with its guard test or accepted-risk justification)
