# Quality before handoff

This is the shared workflow for app and owned prototype changes. Use the
existing worker and canonical prototype boundaries; never copy their code or
resources. Technical planning, graph evidence, ownership, reviews, check output
and corrections stay internal. Aim for work as close to perfect as possible
before handoff, not a backlog of preventable fixes for engineering.

## Communication and product questions

Do not show or ask the person to approve a technical plan, ask a technical
question, or give an upfront summary. Updates say only which requested feature
is complete and what is being worked on next, using the person's own words.
A worker's unit completion is internal until the whole requested feature and
its required consumers are reviewed and verified. Do not narrate prep, file
placement, implementation order, checks or review fixes.

Before any worker returns a product question, research it with closedloop-graph:
`ticket_detail`, `fts_search` and `search_memory_facts` for the relevant ticket,
requirements and prior decisions. Fetch the material decision and comments
through live ClosedLoop and verify current code when relevant. Include the
question, sources checked, any settled ruling and why an unresolved answer is
absolutely necessary. A settled decision is applied, never asked again. Resolve
technical questions from source, repo rules and worker evidence internally.
An empty graph result is not proof that nobody answered the question.

The orchestrator sends an unresearched question back to its worker. Interrupt
the person only for an absolutely necessary unresolved product question, one
at a time with full context, never for an owner, abstraction, backend choice or
technical plan. Preserve existing product approvals such as the primitive's
Storybook approval and canonical prototype design approval; these are not new
technical approval milestones. Existing sign-in, credential entry and OS
permission actions remain with the person, not the workers.

## Local plan and adversarial plan review

The planning worker runs the existing owner and graph prep in `design-pass.md`.
Then load `plan-structure` by name (`$plan-structure` in Codex or
`/closedloop-core:plan-structure` in Claude Code) and read
`resources/plan_template.md` from that loaded skill's own folder. Never copy the
template into this plugin. Use its exact headings and order for the technical
plan, even for a small change; keep it short in proportion to the request.

Write the plan inside the session worktree at
`.closedloop-ai/vibe-plans/<request-id>.md`. Keep revisions and review evidence
in that exact folder. The shared `scripts/local-plans.mjs` boundary makes the
commit script unstage those files, and handoff inventory excludes untracked
plans but blocks a plan already staged or committed. Do not add a broad ignore,
commit a plan, deploy it, put its body in the ticket or upload it as an
attachment or implementation-plan document. The live ticket still records the
person's scope, delivered changes and truthful check/review outcomes, not the
technical plan or a plan-approval milestone.

The commit script refuses a plan already in HEAD, even unchanged. Every app or
prototype publisher also runs `scripts/local-plans.mjs --worktree "<wt>"`
before push/share and publishes nothing when it fails. A leak is not hidden by
rewriting history. Exclude only this exact folder from implementation review
file lists; the separate plan reviewer reads it explicitly.

The plan names each unit's owning files or module, acceptance predicate,
dependencies, and existing validation. Separate independent ownership from
shared-file work. Extend the same local plan for required backend, primitive or
prototype work rather than implementing an unreviewed technical addition.

Dispatch a separate `vibe-adversarial-reviewer` in plan mode with the local plan,
the request and the prep evidence. It challenges ownership, reuse, missing
requirements, both hosts, dependencies, contract safety and realistic checks.
The planning worker fixes confirmed findings and the separate reviewer checks
the revision before implementation. No worker or person approves their own
technical plan; a clean reviewer result is an internal gate, not an Andy
milestone. Resolve review findings from evidence, never by dropping requested
scope. Material approach changes go through this same bounded review.

## Parallel implementation and corrections

Dispatch independent units concurrently only when their writer ownership does
not overlap. Each brief names its exact owned files or module, dependency
outputs and reviewed local plan, says the worker is not alone, and forbids
reverting another worker. Wait for prerequisites before dependent units. One
worker owns a shared parent; consuming workers wait for its contract rather
than simultaneously editing it. Serialize overlapping files and shared
mutation of ticket sections or the change log.

The planning worker is the only local-plan writer; its reviewed plan is stable
during an implementation wave. Aggregate all wave results before revising it
or recording progress. The orchestrator owns session JSON mutations and grants
at most one setup, environment, prototype or ticket worker a record-writing
turn. Do not overlap `touch`, `codex-sessions`, flag/profile/publication or
environment-result writes, or update the record while that granted worker is
active. This preserves existing record APIs without a second storage system.

Generated outputs and the canonical prototype registry count as owned files
too. Different source files do not make generator/publication writes independent.

Parallel workers receive `deferRecords` true and return recording facts instead
of mutating the shared log or ticket. After each wave, one change worker in
record mode validates those results and applies the existing recording steps
serially. Prototype/backend/primitive results follow this same recording boundary.

Use the existing app workers, or the prototype worker's canonical procedure,
to implement the reviewed plan. Worker results retain owner, graph and change
evidence internally. No worker commits; the orchestrator still uses the vibe
commit script. No PR is opened by vibe or handoff.

Before declaring the feature complete, dispatch `vibe-guardrails-reviewer` and
`vibe-adversarial-reviewer` in implementation mode independently of its authors.
Use the named core `workflow-code-review` skill for backend review
(`$workflow-code-review` in Codex or `/closedloop-core:workflow-code-review` in
Claude Code). Route confirmed findings to the owning workers, fix them before
handoff, and re-review the changed result until no confirmed issue remains.
Run lint, relevant typecheck, existing affected tests and Storybook checks;
verify the applicable web and Desktop behavior without weakening a check.
Automated browser checks are headless and Electron checks use the supported
displayless harness, never a visible fallback. Report unsupported local
scenarios precisely rather than silently skipping required validation.

## Tests at handoff only

No build-loop worker writes or edits tests, test fixtures or snapshots. Existing
tests may run before handoff; stories remain part of building the component.
Record the coverage needed in the local plan instead of writing it early.

Missing new-test coverage during building is an explicit handoff obligation,
not a fix-before-handoff instruction to write it early. Existing live-contract
failures remain implementation findings. At handoff the coverage obligation is
fulfilled and independently reviewed before final publication.

At handoff dispatch `vibe-verify-worker` in `tests` mode to add or extend focused
tests for the session's acceptance criteria, production wiring and meaningful
failure paths, for app and prototype work alike. Honor the repo's test integrity
and deliberate-behavior-change rules. Never loosen an assertion, skip a case,
raise a tolerance or timeout, change a harness or suppress a check to get green.
Fix implementation defects in the owning worker, then rerun tests. Review new
tests and their coverage before the final handoff; handoff is the test-writing
boundary and final integrated verification, not the first code-quality pass.
