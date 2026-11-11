# Provider text for skills/vibe/references/quality-loop.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: research-order -->
1. Current code and data model, for what is physically possible.
2. The ticket's acceptance criteria, its PRD and sourced rulings.
3. `ticket_detail`, `fts_search`, `search_memory_facts` and material decisions
   or comments fetched through live ClosedLoop; an empty graph result proves
   nothing.
4. The product owner's recorded direction.
5. The approved prototype.
6. Live Asana in the operator's signed-in Chrome, run by whichever actor has
   the browser; never a public help center or documentation page.
<!-- end: research-order -->

<!-- block: session-text -->
A ticket's or plan's Decisions section is a record, not a ruling. Text the
session wrote (its live ticket, PLN, plan, table, change log) is never a
source. A decision
<!-- end: session-text -->

<!-- block: precedent-source -->
The ordered list above is the only product-question research order. When the
first five sources do not settle how the product should behave, live Asana is
the precedent. Public help centers, documentation and search results are not a
substitute for observing the interaction in the operator's signed-in Chrome.
<!-- end: precedent-source -->

<!-- block: precedent-brief -->
`scripts/precedent-check.mjs` holds the research brief and its safety rules
once, for both harnesses:

- Claude Code: whichever actor has the operator's signed-in Chrome runs
  `node scripts/precedent-check.mjs run --question
  "<question>" --code-evidence "<file:line>" --situation "<what to reproduce>"` in the background. It
  starts a separate headless `claude -p --chrome` limited to the Chrome tools
  with the brief on stdin.
- Codex: no computer use (`guardrails.md`, "Processes and state"). The
  orchestrator runs the same `run` command through an actor with the signed-in
  browser. Without one, the worker returns `NEEDS_PERSON` to the orchestrator;
  nobody falls back to public material.

The brief's rules bind every look: the account already signed in is used,
and nobody signs in, creates an account or types a credential. Nothing that
already exists is touched. Test data goes only in one new private project
named `zz vibe precedent check (temp)`, with no members and notifications
off, every created task prefixed `zz test`; everything created is deleted at
the end and confirmed gone in the report. A flow that would connect an app,
invite or notify someone, share, pay or change a setting goes only as far as
its confirmation step and is canceled there. Every state is verified (reload
and look again; a hover can look like a completed task) before it is
recorded, only what was observed directly counts as precedent evidence,
on-screen wording is quoted exactly as evidence, and a situation Asana does
not settle is reported as `undocumented`, never guessed. A failed or
`undocumented` run leaves the question to the person.
Before an answer is recorded, `node scripts/precedent-check.mjs check
--report <report>` must pass. Public material is not precedent evidence. Pass each disputed
behavior the question turns on as `--behavior "<the interaction to perform>"`
to `run`: `check` then refuses a report until every one is observed with a
screenshot or marked `needs a write to test` for the operator.
<!-- end: precedent-brief -->

<!-- block: precedent-record -->
The answer goes to the SAME writer, which records it in the session decision
table as the decision for the affected rows, with its source: the ticket or
PRD slug for a requirements answer, a code path for a feasibility answer, or
`Asana, observed <date>` for the live precedent. A precedent is the
default, not a human ruling: it never overrides a settled decision, a later
human statement supersedes it with an explicit `Superseded` entry, and it
settles behavior, never user-visible words (`guardrails.md`, "Copy").
It settles only what nothing specifies: first read the ticket's scope, the
pull request's human threads and DONE or open sibling tickets; a stated
requirement there wins.
<!-- end: precedent-record -->

<!-- block: decision-table-path -->
The Spec Card (`spec-card.md`) seeds this table's `## Acceptance Criteria`
section and Open Questions; it never replaces the table, its rows or its
passes. Keep one living table for the whole session at
`.closedloop-ai/decision-tables/<session-slug>.md`, in the SAME worktree and
branch, authored only by the SAME persistent writer. New requests extend that
file before code; they never start or replace a per-request table. Use real
source-backed rows with stable row IDs, request provenance and grouped behavior
sections. Inventory actual callers, contracts, gates and host capabilities;
read visibility does not prove a write path works on every host. Model the
request's applicable cases and cross-request interactions with prior rows.
<!-- end: decision-table-path -->

<!-- block: plans-pln -->
The local plans under `.closedloop-ai/vibe-plans/` reach ClosedLoop only as
the session's PLN ("Local plan" below). The behavior-table attachment at
handoff remains separate; a plan or its review drafts are never attached as
table evidence.
<!-- end: plans-pln -->

<!-- block: local-plan -->
Write the technical plan inside the session worktree at
`.closedloop-ai/vibe-plans/<request-id>.md`, with revisions/review evidence in
subfolders of that exact folder, which stay local. Never commit, deploy or
paste it into the ticket, and never attach it. The ticket worker publishes the
folder's top-level plans as the session's ONE implementation plan document
(PLN): in the live ticket's project, assigned to its assignee, linked ticket
PRODUCES PLN, and given a new version only when the plan changed materially
(`../../../agents/vibe-ticket-worker.md`, "Source link and session plan"). The PLN is `DRAFT` while its latest plan is not built,
`APPROVED` once the session wrote and checked the code, and `EXECUTED` once the
pull request merged. So write every plan for an engineer who never saw the
session, under the live ticket's safety rules: repo-relative paths only, and
no local absolute paths, usernames, personal emails, secrets, credentials or
private session inputs (the session record, the writer's queued requests,
flag or sign-in files). `scripts/session-plan.mjs` makes the session's own
checkout paths repo-relative and refuses anything else; a refusal comes back
to this same writer to fix in its local plan. The live ticket still records
scope, delivered changes and truthful outcomes, not technical plans or
approval milestones.
<!-- end: local-plan -->

<!-- block: plan-folder-exclude -->
The commit script excludes this exact folder and refuses a plan already in
HEAD. Every publisher also runs `scripts/local-plans.mjs --worktree "<wt>"`
and publishes nothing on failure. Do not hide a leak by rewriting history or
broadly ignore other ClosedLoop artifacts. Handoff reviewers exclude only
this exact folder from deliverable files.
<!-- end: plan-folder-exclude -->

<!-- block: pln-reuse -->
The plan gets no review: the writer writes it and builds in the same turn. On startup, resume, fleet takeover or handoff with an
existing `liveTicket`, list outgoing `PRODUCES` links and reuse one PLN. With
none, the SAME writer first writes the core plan covering every criterion and
continues building; plan mode publishes `built: false` without a person wait,
second PLN or build/deploy pause. Later changes return to that writer.
<!-- end: pln-reuse -->

<!-- block: control-read -->
- one bounded `pnpm control` read against the running app under the control
  skill's own rules (hidden, read-only, `pnpm control down` for every session
  it started), only where that is the honest way to check it, such as URL
  state surviving a reload or a copied link opened fresh;
<!-- end: control-read -->

<!-- block: main-bootstrap -->
- When a handoff check fails, the executor runs that same check on the main
  the session captured (the transaction's `mainSha`) in a disposable checkout
  of that commit. The checkout is bootstrapped once with the repository's own
  `.closedloop-ai/loops-setup.sh`, the same pristine bootstrap the input
  readiness uses, shared by every failing check, and removed afterwards. A
  check whose selection follows the session's diff (the affected wrappers, the
  pinned Turbo filter) runs the same task over the packages the session
  selected. A check that passed is never rerun. Each run is bounded by that
  check's own time limit through `scripts/run-bounded.mjs`.
<!-- end: main-bootstrap -->
