# Feature Manual QA

Use this protocol after the feature pull request exists and before any
ready-to-merge disposition. A feature is one complete selected user-facing page
or capability delivered end to end; a PRD is not automatically one feature.
Its required backend, production UI, and relevant Storybook or component flows
must ship through one integrated PR and one feature-wide manual QA record. Do
not require unrelated pages or every other child of the same PRD in that PR or
test plan. Separately owned shared-foundation prerequisites may remain external
when the feature contract identifies and verifies them. When the feature changes
common code, include regression coverage for every materially affected consumer
without turning each unrelated page into part of the feature. Do not create
per-surface PRs or mark the whole feature complete from isolated member-ticket
evidence. Factual per-ticket validation evidence remains useful, but Storybook
and mocks do not prove that the selected page or capability functions.

## Reuse the guided QA contract

Before drafting the PR comment or running a session, read the sibling
[`guided-manual-qa` skill](../../guided-manual-qa/SKILL.md), its
[`plan-methodology.md`](../../guided-manual-qa/references/plan-methodology.md),
and its [`qa-record-template.md`](../../guided-manual-qa/references/qa-record-template.md).
Use that skill's evidence map, risk ranking, oracle proof, checkpoint meanings,
durable-record discipline, and human-confirmation rules. This reference adds
feature-PR ownership and lifecycle rules; it does not duplicate or weaken the
guided QA methodology.

Creating the PR comment creates the test plan only. It does not start the
interactive guided QA session, launch a browser or application, or authorize
visible automated E2E. Start the session only with the responsible human
author's participation. Keep automated browser E2E headless and Electron E2E
displayless under repository policy.

## Create one owned feature plan comment

Immediately after opening the PR, resolve its exact URL, head SHA, and author
identity from live GitHub. Read the exact plan template at
`../../plan-structure/resources/plan_template.md`, resolved relative to this
reference file's installed skill pack, immediately before drafting or revising
the comment, and use that template's exact headings and order. Build the
scenario inventory from the guided QA
methodology and add this stable ownership marker to the body:

```html
<!-- cl-execute-feature-manual-qa:v1 -->
```

Post exactly one comment owned by this execution on the PR. Before creating
one, search the PR comments for that marker and the current execution owner. If
an owned comment already exists, update it in place. If the marker exists but
ownership is different or cannot be proven, do not edit it or post a duplicate;
return the exact comment-ownership blocker. Never create a duplicate merely
because a plan or result changed. After every create or update, fetch the
comment by its id, verify its URL and full body, and retain the id and URL as
the QA-plan artifact.

The comment must identify the current cl-execute execution owner and cover the
complete feature, including:

- the feature identity, every member ticket and plan, and explicit coverage
  mapping between all acceptance criteria and scenarios. One scenario may cover
  several criteria, and one criterion may require several scenarios;
- the exact PR URL and head SHA being planned, plus the live PR author identity.
  When the GitHub author is a bot or other nonhuman identity, resolve an
  explicitly designated responsible human author or owner; never invent human
  confirmation or automatically assign the current user;
- a reproducible safe environment using the exact PR worktree or build,
  repository-supported launch paths, non-production services, explicit flags,
  permissions, fixtures, reset steps, and cleanup;
- an integrated real shipping workflow. Where the feature spans backend and
  production UI, exercise that end-to-end flow. Otherwise exercise the actual
  shipping API, CLI, worker, desktop, or other owning surface without inventing
  a UI. Storybook, isolated components, mocks, screenshots, agent inspection,
  and automated tests may support but cannot replace the shipping workflow or
  human confirmation;
- expected outcomes tied to specific acceptance criteria, plus relevant
  failure, error, boundary, and adjacent-regression scenarios selected through
  the guided QA risk method;
- every scenario in `PENDING` state initially, with prerequisites, one human
  action or observation, expected result, evidence to capture, dependencies,
  and cleanup/reset needs;
- explicit responsibilities: the agent prepares the environment, proves each
  oracle, maintains the comment and durable record, and remediates failures;
  the responsible human author performs or observes each checkpoint and
  supplies the confirmation and evidence;
- the durable guided QA record location and a results area for tested head,
  confirmer, evidence references, scenario status, findings, and carry-forward
  decisions.

The `$cl-execute` invocation includes standing authorization to create and
maintain this owned feature QA comment. That authorization does not extend to
ticket comments, messages, assignments, manual CI triggers, automated-review
triggers, or a new coordinated review generation.

## Execute and record the session

Create the durable untracked record from the guided QA template before the
first checkpoint and copy the complete feature scenario inventory into it. The
same cl-execute owner that opened the PR retains setup, execution,
remediation, and reconciliation ownership; do not delegate QA ownership to the
sweep parent or a support lane. Run the guided session one checkpoint at a time
with the responsible human author. Record the exact tested head, actual outcome,
human confirmer, time, and evidence for every scenario in both the local record and
the owned PR comment. Agent-observed screenshots, logs, probes, and automated
checks remain supporting evidence and cannot produce `PASS` or substitute the
responsible human author's confirmation.

If the responsible human author is unavailable, leave all unrun scenarios
`PENDING`, update and verify the owned comment, and return human-readable status
`WAITING_MANUAL_QA`. Transport that wait through the existing `WAITING_HUMAN`
callback kind with `payload.summary.wait_kind: manual_qa`, concrete artifact
references, and `payload.routing.recheck_when` naming the author-response event.
Do not introduce a new callback kind. Pending or blocked manual QA cannot be
described as functional, complete, ready, queued, or waiting only for human
merge. A sweep parent may route the human response back to this same owner and
continue passive PR monitoring, but it does not execute QA or mark scenarios
passed.

When a scenario fails, preserve the evidence and remediate the required
functionality under the existing execution authorization. Run focused automated
validation and repeat affected human checkpoints. Do not defer a requirement,
acceptance failure, broken integrated flow, or relevant regression to cleanup.
Remediation does not authorize manual CI/review triggers or a third coordinated
review generation.

Append one decision-log row (Execution step 12 in
[implementation-review-pr.md](implementation-review-pr.md)) for each checkpoint
verdict change, carry-forward, oracle correction, and reset, with the record
section as evidence. The record stays the full ledger.

## Keep evidence bound to the final change

With every tested head, record its merge base and the stable patch-id of the
PR's own change:

```sh
git diff --binary $(git merge-base origin/main <head>) <head> | git patch-id --stable
```

After every PR head change, mark the overall manual-QA state stale, fetch
`origin/main`, and compute the same patch-id at the new head. Apply the
head-change rule in the guided QA skill's
[`plan-methodology.md`](../../guided-manual-qa/references/plan-methodology.md)
"Rebind results after a head change", with `origin/main` as the base and the
[Discovery Routes](../SKILL.md#discovery-routes) for the reach check, then
update the owned comment as below.

A matching commit message, a green check from an older SHA, or an unchanged
branch name never substitutes for the patch-id comparison. Carry-forward means
the prior-head result remains applicable; never claim the unchanged scenario
was exercised on the new SHA. Update the owned comment in place with the new
head, both patch-ids, invalidated scenarios, carry-forward justifications, and
remaining work, then verify the comment again. The same binding governs
`Repo verification evidence` and `Safety fact` (Validation step 3 in
[implementation-review-pr.md](implementation-review-pr.md)).

Manual QA passes only when the relevant final PR head has responsible-human `PASS`
evidence for every required scenario across the integrated feature and no
required scenario is `FAIL`, `BLOCKED`, or `PENDING`. Automatic CI, existing
review handling, and passive monitoring may continue while the human session is
pending, but only a passing QA state permits the worker to claim the feature
functions or proceed to queueing, merge disposition, and completion. Merge
evidence alone cannot close the feature when manual QA evidence is absent or
stale.
