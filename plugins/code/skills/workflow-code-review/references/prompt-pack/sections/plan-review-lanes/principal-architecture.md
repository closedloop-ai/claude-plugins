# Principal Architecture Lane

Read `sections/plan-review-lanes/common.md` first; it defines the shared lane contract, evidence JSONL shape, and verdict semantics.

This lane must invoke `$principal-engineer` and perform a focused design-quality review of module boundaries, ownership fit, maintainability, testability, duplication, abstraction quality, route/component/service responsibility split, future extension pressure, and whether the plan creates code that will be hard to reason about or change. It is a core lane and always runs. This is separate from executor-readiness, adversarial contract, API/Data-Model Ownership, and security-abuse review. It must be read-only and must not implement fixes.

## Applicability

Architecture/maintainability-sensitive work includes any work touching:

- new or substantially changed services, routes, hooks, UI workflows, workers, command handlers, plugins, skills, shared helpers, or package APIs
- cross-repo, cross-process, persisted, or independently deployed contracts
- non-trivial refactors, new abstractions, module moves, helper extractions, shared constants, schemas, validators, or type surfaces
- areas where the plan adds similar behavior in multiple places, changes ownership boundaries, or introduces fallback/compatibility logic
- work where a human, reviewer, plan author, or prior failure intake raises concerns about "hack", "wrong abstraction", "brittle", "overfit", unclear ownership, hard-to-test design, or maintainability risk

The lane may return `not_applicable` for docs-only, copy-only, test-only, fixture-only, or purely mechanical one-file changes with no new abstraction, boundary, or ownership decision. If applicability is unclear, it must invoke `$principal-engineer` and return a substantive finding or blocker rather than `not_applicable`.

## Required Checks

The reviewer must inspect the work item, generated or linked plan, repo guardrails, current implementation boundaries, relevant files/modules/call sites, nearby helpers/types/validators/constants/tests, and any cross-repo or cross-process contracts needed to answer:

> Does this plan put the behavior in the right module and shape it in a maintainable, testable way without creating avoidable duplication, brittle abstractions, or hidden coupling?

The reviewer must check:

1. Which code ownership boundary the plan changes or depends on.
2. Whether the Principal Design Synthesis considered the right 1-3 approaches, selected the simplest correct ownership-aligned approach, and rejected worse alternatives with repo evidence.
3. Whether route handlers, UI components, hooks, services, workers, plugins, and helpers keep appropriate responsibilities.
4. Whether the plan reuses existing helpers, validators, constants, schemas, types, and tests before adding new ones.
5. Whether new abstractions name real concepts and remove meaningful duplication or improve a testable boundary.
6. Whether the plan avoids speculative frameworks, vague utilities, or broad rewrites outside the work item.
7. Whether expected domain outcomes use typed results, stable errors, schemas, or validators where the repo has those patterns.
8. Whether test coverage targets the behavior risk rather than implementation trivia.
9. Whether cross-boundary contracts remain version-tolerant and easy to extend.

The reviewer must also check whether:

- the plan includes a Principal Design Synthesis in `Architecture Fit` with viable approaches considered, selected approach, rejected alternatives, ownership fit, compatibility/security/testability/maintainability tradeoffs, and smallest safe implementation sequence
- architecture/maintainability-sensitive work has an explicit Principal Architecture review using `$principal-engineer`, with findings classified as `Fix now`, `Ask first`, `Follow-up`, or `Ignore`

## Lane Focus

- Verify the plan has the smallest coherent ownership boundary, no avoidable new abstraction, and no cross-module coupling that violates package conventions.
- Require explicit sequencing for remote IO, durable writes, retries, and user-visible state reconciliation when those surfaces interact.
- Fail this lane if the plan is locally correct but creates confusing split ownership, duplicated source-of-truth logic, or hidden transaction/side-effect coupling.

## Finding Classification

The Principal Architecture reviewer must classify each finding as:

- `Fix now`: directly affects the current plan, is repo-local, and would make the implementation unsafe, brittle, duplicated, hard to test, or inconsistent with existing ownership boundaries.
- `Ask first`: affects product behavior, public contracts, schema, migrations, broad module boundaries, or a risky abstraction choice that cannot be resolved from repo context.
- `Follow-up`: a real issue outside the safe scope of this work item.
- `Ignore`: stylistic or speculative with no concrete maintainability payoff.

## Required Principal Review Section

The Principal Architecture reviewer must return a Principal Review section with:

- Fixed now candidates
- Ask first decisions
- Follow-up recommendations
- Not changed / ignored items
- Principal Design Synthesis verdict, including whether the selected approach is the simplest correct design
- files/modules/call sites inspected
- verdict: `PASS` | `FAIL` | `BLOCKED`
- required correction or human/product/architecture decision

## Failure Rules

Fail the plan if any `Fix now` issue remains unresolved. Block the plan if any `Ask first` issue must be decided before execution. Do not block the plan for `Follow-up` or `Ignore` items, but include follow-up items in the handoff summary when useful.

## Lane-Specific Evidence Matrix Rows

In addition to the generic rows in `common.md`, include:

- Principal Design Synthesis checked, including selected approach, rejected alternatives, ownership fit, and whether it is the simplest correct design
- principal review classification, including module/ownership fit, duplication/abstraction risks, testability risks, and `Fix now` / `Ask first` / `Follow-up` / `Ignore` disposition, if architecture/maintainability-sensitive
