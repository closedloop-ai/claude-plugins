# Risk-Based Plan Methodology

Read this reference while deriving or revising the manual QA plan. It is a decision framework, not a fixed checklist.

## Build an evidence map

Start from current evidence rather than the title alone:

- requested behavior and exact, versioned acceptance criteria and approved requirements;
- live base-to-head and uncommitted diffs;
- applicable repository instructions;
- owning modules, callers, consumers, routes, persistence, and transport boundaries;
- nearby existing behavior and established interaction patterns;
- tests that reveal intended invariants and known boundary cases;
- feature flags, permissions, configuration, packaging, and rollout boundaries;
- verified repository-memory hints when the repository requires memory lookup.

For every changed behavior, identify where it ships and where the old behavior must remain unchanged. Follow shared code to each real consumer, but stop once one bounded adjacent pass produces no new material surface. A prototype is eligible as a manual harness only for the exact asserted code also imported by production or Storybook; a similar visual copy, route-only behavior, or mock-only behavior is not. Keep evidence for intentionally excluded surfaces so omission is visible rather than silent, and carry any underlying acceptance requirement to its real owner or an explicit coverage gap.

### Discovery routes

When the closedloop-graph tools are available, find things through them first and verify each answer in the worktree. The graph indexes the default branch only, so this change's own edits are never in it.

- Consumers of changed code: `code_symbols` for the repo-qualified path, then `code_callers` and `code_importers`; `code_grep` for routes, flags, test ids, and event names. Verify with `rg`.
- Candidate E2E coverage: `code_tests_for` on each changed file (`code_callers` drops test rows), then read the spec and confirm the assertion and a current-head run as `SKILL.md` requires. A graph hit is a candidate, never coverage.
- Prior QA on the same surface: `blast_radius_tickets` on the changed files and `ticket_detail` for their PRs, then read those PRs' manual-QA comments with `gh`. Reuse a prior scenario's path and fixture only after re-proving its oracle here.

A graph zero is a claim about the query, not about the code. Without the graph, use `rg` for consumers and E2E candidates, `git log -S` for the history of a string or symbol, and `gh` for prior PRs and their comments. Say which route produced each piece of evidence.

## Separate E2E coverage from human checkpoints

Map each proposed observation to a passing E2E assertion on the current head. Count it as covered only when the same shipping host, flag assignment, fixture transition, action, and expected outcome are exercised. Record the test, assertion, head, and result in the QA record. Put only uncovered behavior and explicitly human-only requirements in the manual queue; a related test or a broader green job is not enough. Recheck the map after a head change, as the next section describes.

## Rebind results after a head change

Record the merge base and the stable patch-id of the change with every tested head: `git diff --binary $(git merge-base <base> <head>) <head> | git patch-id --stable`, where `<base>` is the resolved base branch (for example `origin/main`). When the head moves, mark every result stale and compute the patch-id again.

- Patch-id unchanged: the head only integrated the base branch. List the files the base changed between the two merge bases (`git diff --name-only <old-merge-base> <new-merge-base>`). When the closedloop-graph tools are available, find what those files reach with `code_importers` and `code_callers` on each file and `code_grep` for routes, flags, and other strings, then verify with `rg` in the worktree; otherwise use `rg` alone and say so. Carry forward each checkpoint whose surface, fixture, and oracle none of those files reach, and reset the rest to `PENDING`.
- Patch-id changed: reset each checkpoint the delta reaches directly or indirectly. Carry one forward only with a written reason that the changed files cannot affect its surface, fixture, oracle, or requirement.

A carried-forward result applies to the new head; it was not exercised there. Never claim otherwise. Record every rerun, reset, and carry-forward as a new attempt row in the checkpoint's attempt table; never edit an earlier row.

## Rank scenarios

Prioritize a remaining manual scenario when one or more of these is high:

- user or data impact if wrong;
- likelihood suggested by the implementation shape;
- poor coverage by automated tests;
- difficult rollback or diagnosis;
- a boundary crossing, such as client/server, process, persistence, version, or permission;
- shared code with multiple consumers;
- a requirement that is easy to satisfy technically while misrepresenting behavior to a user.

Prefer a small set of discriminating scenarios over many cosmetic repetitions. A useful plan generally establishes:

1. environment and data integrity, including the approved browser origin and the actual database/service owner;
2. the primary success path;
3. changed edge and failure paths;
4. the highest-risk adjacent regression;
5. parity across actual consumers when shared behavior can diverge.

## Bug-fix checkpoints

For a change that fixes a reported bug, the primary checkpoint is the original reproduction on the surface where it was reported. Before scheduling it, name the correct final state and the broken final state; a setup step, expected dialog, or loading state is not the bug. Reuse a recorded repro of the bug if one exists, as the checkpoint's path and its "before" evidence; otherwise reproduce it yourself on the base, twice, before scheduling the checkpoint. Do not ask the human to reproduce it on the base unless you cannot reach that surface, and record why.

The human checkpoint passes only when the human reaches the point of divergence on the head and sees the correct final state. For an intermittent bug, ask for two independent runs. An observation that does not show the discriminating state, or one made on a different surface, is `BLOCKED` with reason "inconclusive", never `PASS`.

## Apply conditional lenses

Only add a lens when the change or repository makes it relevant:

- **Web/UI:** loading, empty, success, failure, navigation, refresh, responsive widths, theme, keyboard order, focus, accessible names, announcements, and truthful state.
- **API:** request and response shape, authorization, validation, idempotency, partial failure, compatibility, and observable error semantics.
- **Desktop/Electron:** renderer/main boundaries, local gateway or IPC, packaging-dependent resources, reconnect or restart, and parity with shared web behavior.
- **Persistence:** migrations, create/update/delete behavior, reload, concurrency, cleanup, and valid handling of absent or corrupt input.
- **Flags and permissions:** both assignments, direct navigation, stale state, role transitions, and closed or safe defaults.
- **Cross-surface/shared code:** every shipping consumer, surface-specific adapters, and any intentional semantic difference.

Do not presume that all of these exist. Record `not applicable` only with a short reason grounded in the change or repository.

## Write executable checkpoints

Each checkpoint should include:

- risk or requirement covered;
- prerequisites and exact starting state;
- one human action or observation;
- expected visible or behavioral result;
- evidence to capture;
- dependencies on earlier checkpoints;
- safe reset or cleanup when stateful;
- the entry point used, named by feature-map id and route when the repository keeps a feature map;
- for a write, a second view that shows the stored value (reload, reopen from the list, or a different surface), because a success toast alone is not proof.

If an entry point the change touches cannot be reached, mark its checkpoint `BLOCKED` with the attempted route and the unmet precondition. Never pass it through a different entry point.

Avoid checkpoints that ask the human to judge multiple independent claims at once. Split them so a result is unambiguous.

Do not make remote-preview availability a prerequisite unless the user or current repository instructions explicitly selected that preview. For local QA, treat exact-worktree listeners, data-service ownership, migration/seed state, and the browser's local origin as pre-checkpoint gates. When both Docker and native services exist on the machine, name the intended owner and prove the app is connected to it instead of relying on a `localhost` URL alone.

## Prove the oracle, not just the scenario

Before a checkpoint reaches the human, trace the asserted result to the exact shipping surface. A nearby test or component is evidence only when the live route uses the same mode, renderer, and projection. Similar surfaces can intentionally differ, such as list versus detail, free-text versus faceted results, read-only versus editor variants, or web versus desktop adapters.

For each checkpoint, record:

- the exact owner of the visible behavior;
- for a prototype harness, the actual import/consumer path that makes the asserted behavior production- or Storybook-reachable, or the reason it is `NOT APPLICABLE`;
- the exact acceptance criterion or other approved requirement that establishes the expected outcome, and why it applies to this surface;
- whether any added expectation is an explicit clause or an inference being tested diagnostically; internal matrices, source comments, and tests do not make an inference mandatory;
- the production path and behavioral tests that corroborate reachability or current behavior;
- proof that the fixture reaches that path;
- active defaults, persisted controls, hierarchy/context retention, grouping, and pagination that alter counts or membership;
- fields or interactions intentionally absent on that surface.

Use a cheap independent probe for an exact count or membership claim when possible. If the evidence cannot yet distinguish expected absence from a defect, make the next checkpoint diagnostic and avoid product-failure language. When later evidence invalidates the expectation, classify it as an oracle correction and revise the plan rather than turning the human's accurate observation into a false bug. Do not dispatch remediation from a diagnostic observation until an applicable approved requirement or a new operator decision establishes the obligation.

## Adapt without losing scope

After a failure, add only diagnostics that separate plausible causes or establish a minimal reproduction. Mark dependent coverage blocked until the prerequisite is restored; do not relabel it passed or remove it. After a blocker or documented fallback, update the plan and record which evidence is no longer equivalent to the original target.
