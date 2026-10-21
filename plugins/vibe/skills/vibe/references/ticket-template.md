# The live ticket

Every vibe session has one ClosedLoop issue ticket, created when the session
starts (assigned to the person running the session, the session record's
`operator`, status In Progress) and kept current by the
workers while the person works. Engineering and design read it to know what
was built, what is missing, and where to look. Handoff checks it is complete;
it never writes it from scratch.

## Rules for every worker that edits it

Owned prototype sessions retain these headings and ownership rules. Their
record sections truthfully name the canonical immutable prototype preview,
slug, full deployed SHA and verification timestamp, with `None.` for the
production flag snapshot. No app/API/Storybook URLs or seeded/blank data are
fabricated. Backend built is `None.`; Backend still missing lists evidenced
promotion work or `None.`. Handoff includes the canonical decision log and
single design-review result alongside shared-surface stories, check/review
summaries, and the person's resolved next owner. The sole implementation writer
owns source/local metadata; the operational prototype helper records verified
publication, and the same ticket worker verifies completeness and assignment.

- Read the latest version with `get-document` (`includeContent: true`, a large
  `contentMaxChars`) immediately before you write, change only the sections
  your step owns (table below), keep every other section exactly as it is,
  and write the whole body back with `create-document-version`. Never edit
  status, assignee, or title unless your instructions say so.
- The Environment, Production flag snapshot, and Sessions sections are never
  written by hand: run `node <vibe skill>/scripts/vibe-sessions.mjs
  ticket-sections --worktree "<wt>"` and paste its `markdown` over those three
  sections.
- `Pending.` marks a section or line nobody has filled yet. Replace it when
  you fill it; leave it when you have nothing for it. Handoff refuses a ticket
  that still has one.
- Write for an engineer who never saw the session, in plain words. Use the
  person's own words for what they asked for; never invent requirements.
- ClosedLoop strips angle-bracketed text from ticket content, so anything
  written in angle brackets (a component like `<TagMenu>`, a placeholder like
  `<tag>`) must go in a code span or it disappears.
- Keep the headings exactly as below; the handoff check finds sections by
  heading.
- Technical plans in `.closedloop-ai/vibe-plans/` never go into this body
  and never get a plan-approval milestone. They reach ClosedLoop only as the
  session's one implementation plan document (PLN), which the ticket worker
  publishes from them, links from this ticket (ticket PRODUCES PLN), keeps
  current and moves from `DRAFT` to `APPROVED` to `EXECUTED` as the work does;
  the document the session started from is linked to this ticket (source
  PRODUCES ticket) (`../../../agents/vibe-ticket-worker.md`, "Source link
  and session plan").
  This body and the PLN follow the same safety rules: no local absolute
  paths, usernames, personal emails, secrets or credentials, and no private
  session inputs. Product scope and truthful delivery/review history remain
  here.
- Hard rule for this body, the PLN and the pull request: never reference a
  path on the operator's machine (home, temp, scratchpad, worktree or
  `.control/` paths) or say something is on someone's laptop.
  - Embed a screenshot with `create-document-version` `inlineImages`.
  - Quote text evidence inline, briefly.
  - A plan is attached, never pointed at: the implementation plan is the
    linked PLN, and a QA plan or other working file is uploaded with
    `upload-attachment` and named by its attachment name.
  - `live-ticket-check.mjs` refuses a line naming a local path or the local
    plans folder.
- Conflicts: each `Conflict` the change log records (Placement blocks and
  owner prep) goes in exactly one section, by its audience. `design`
  (Storybook sidebar placement, taxonomy and story granularity, visual or UX
  choices) goes on Design Review's Design conflicts line. `engineering`
  (everything else, including code ownership, which package or shared parent
  owns behavior, and duplication), and any entry without a clear audience,
  goes at the end of the Engineering checklist as
  `- [ ] Resolve conflict: <what disagreed>; decided: <how>; evidence: <doc section or precedent paths>`.
  Each states the conflict, how the session decided it, and its evidence.
  Never route one to the person running the session.
- Engineering needed: each `Engineering needed (forbidden path)` entry the
  change log records (`guardrails.md`, "What may change") goes once at the
  end of the Engineering checklist as
  `- [ ] Engineering needed (forbidden path): <path or area>; why: <need>`;
  the same path or area logged again is the same item. Never in the Handoff
  section, and never routed to the person running the session.
- Engineering decisions: each `Engineering decision` entry the change log
  records (a named mechanism the session swapped, or a handoff finding that a
  mechanism, a one-way door, or an unratified or conflicting decision needs a
  human decision) goes once at the end of the Engineering checklist as
  `- [ ] Engineering decision: <question>; built: <what the session built>; evidence: <files, records or finding>`.
  Never in the Handoff section, and never routed to the person running the
  session.
- Known main failures: each entry of handoff's `mainPreexistingFailures` (a
  check that also fails on the main the session captured; `quality-loop.md`,
  "Failures already on main") goes once at the
  end of the Engineering checklist as
  `- [ ] Known main failure: <check>; fails on captured main <mainSha>; evidence: <first error line of the main run's log>; exit <main exit code> on captured main, <session exit code> on the session commit`.
  Not on the Handoff section's Pre-existing failures line, never in both, and
  never routed to the person running the session. It does not block
  assignment or the pull request.
- Compile-only v1.0 repairs: each file in the handoff inventory's
  `compileOnlyV1Repairs` goes once at the end of the Engineering checklist as
  `- [ ] Check compile-only repair to v1.0: <file>; confirm only prop, import or type changes and no visual change`.

| Section | Written by | When |
|---|---|---|
| What this is | `vibe-ticket-worker` | session start |
| Scope and acceptance criteria | `vibe-ticket-worker`, then the SAME persistent `vibe-change-worker` | session start; whenever the person changes what they want |
| Environment | `ticket-sections` (via `vibe-environment-worker`) | environment start, every redeploy |
| Progress | the SAME persistent writer; operational environment/ticket helper in a serial record turn | after each change and each redeploy |
| Backend built, Backend still missing | the SAME persistent writer | as backend work is built or found missing |
| Production flag snapshot | `ticket-sections` (via `vibe-environment-worker`) | environment start, a refresh the person asked for |
| Sessions | `ticket-sections` (via `vibe-environment-worker`, `vibe-ticket-worker`) | every redeploy, handoff |
| Handoff | `vibe-ticket-worker` | handoff |
| Design Review | `vibe-ticket-worker` | handoff, from verified final code/publication and actual design evidence |
| Grading | `vibe-ticket-worker` | handoff, copied unchanged from this template |
| Engineering checklist | `vibe-ticket-worker` | session start; handoff appends engineering conflicts, forbidden-path needs, compile-only v1.0 repairs, engineering decisions and known main failures |

## Body

````markdown
## What this is

<Two or three sentences in the person's words: what someone will be able to
do and why it matters. Name the originating ticket if the session started from
one.>

Built in a vibe session by <operator name>.

## Scope and acceptance criteria

- Scope: <what is in, what is deliberately out>
- Newest ruling: <slug, date and quoted words of the newest human ruling on
  this capability, or none found (searched: the searches run)>
- Prior removal: <slug of the ruling that removed a user-visible element this
  work adds and the ticket does not name verbatim, or none found (searched:
  the searches run)>
- Acceptance criteria:
  - [ ] <one checkable line each, quoted from the person or the originating
    ticket>

## Environment

<From ticket-sections: branch and base, seeded or blank data, the Vercel app,
API, and Storybook URLs, and the last deployed commit.>

## Progress

- <date>: <one line per change or redeploy, newest last>

## Backend built

<One line per endpoint, service, type, model, or migration built, with its
path and decision table, or "None: every screen uses existing API endpoints.">

## Backend still missing

<What the screens need that is not built yet, or "None.">

## Production flag snapshot

<From ticket-sections: when it was taken, for which PostHog user, every flag
with its value, and "Keys to see this work" (`guardrails.md`, "Feature flags").>

## Sessions

<From ticket-sections: the Codex session ids of the orchestrator and every
subagent that worked on this.>

## Handoff

<Filled at handoff.>
- Production impact: <if merged, production-only added/changed/removed component
  paths and effects, including the shared parent and its consumers and relevant
  web/Desktop consequences (affected, unchanged or source-backed N/A). This is
  not already shipped. Keep story/test/prototype-only artifacts in their separate
  evidence inventories, not this production list; use "None" when there are no
  production component changes.>
- Flag changes and gates: <exact keys classified as new, existing modified or
  removed, with owning source paths and the changed code's gated entry points,
  reads, mutations and host gates. Include relevant existing gates, not only
  Labs flags. Say "No new flags" when the verified diff establishes that, but
  still list existing modified/removed keys and gates around changed code.
  Separate source defaults (source evidence), actually verified production
  values (timestamp and evidence), and local QA settings/toggles. Mark production
  verification unavailable or stale when it is; never guess a value or present
  source defaults/local QA as production truth. Record this delta/gate evidence
  without overwriting the machine-generated snapshot or implicitly refreshing it.>
- Open Questions: <only genuinely unresolved Product/Design/Scope questions
  after graph and live ClosedLoop research under quality-loop.md: sources checked,
  context and the decision needed. Exclude answered or settled questions; an
  empty graph result is not proof they are unanswered. Keep engineering limitations
  in known gaps, never a technical approval request. Write "None" if research
  leaves no genuine open question; do not invent a question or product copy.>
- Design decisions: <one line per non-trivial request: the owner it was
  built in and the rule that chose it; for each restructure during building or handoff, the
  owner, its shape, and the alternative rejected and why>, or "none: only
  copy, color, or spacing changed"
- Storybook footprint: <components added and changed with story counts, net
  sidebar rows, governance problems left>
- Storybook placement: <each story or shared component added, retitled or
  moved: its placement and the doc section or precedent it follows, from the
  writer's Placement blocks>, or "None: no story or shared component placed"
- Checks: <lint, source gates, typecheck, existing tests (every lane when the
  session changed backend code), each pass or fail; a check that also fails
  on captured main reads "fails on main too, see Engineering checklist", and
  a flaky one "passed on its one rerun">
- Running app checks: <for each screen the session touched, on web and
  Desktop, the `pnpm control` commands run at handoff on the final commit and
  each result with what it proves (embedded capture, console errors and page
  errors, network, API or Desktop IPC reads), before and after when a
  baseline exists. Keep these apart from source-only claims. A surface that
  control could not drive names the exact control command and the reason;
  never claim it verified>, or "None: owned prototype session"
- Reviews: <n fixed, n rejected; one line each, rejected with why>
- Session decision table: <the one session table, attached, whole-table final
  alignment and actual row/test evidence across all requests; not a technical plan.
  Name the attachment and its Frozen Behavior row IDs: the behavior the person
  accepted, which engineering keeps passing with tests in its pull request and
  changes only with that person's explicit OK>
- Feature docs: <each existing product docs page under
  `apps/web/content/docs/` that describes a changed feature, with the passage
  that no longer matches what was built, for design or engineering to update.
  Nothing agent-written goes into public docs, so no page is edited on this
  branch. Internal engineering docs under `docs/` are left to engineering's
  pull request>, or
  "None: no existing product docs page describes the changed features"
- Missing tests (engineering scope): <every test the session still needs,
  which engineering writes in its pull request: the behavior and stable row
  ID each covers, the files that need coverage, and any existing test a human
  behavior ruling made obsolete, with that exact ruling. Vibe and handoff
  write no tests>, or "None: existing tests cover every row"
- Retired tests deleted: <each test file or case the session deleted because
  it covered only code this session retired, from the handoff inventory's
  `retiredTests`: its path and case, the retired code it covered, and the
  ticket or PRD that retired it>, or "None"
- Pre-existing failures not touched by this work: <list or "none"; a Known
  main failure is on the Engineering checklist instead, never here too>
- Next: <the next owner the person chose at handoff, by full name> picks
  this up. Usually design reviews the components in the Storybook above (it
  opens after signing in to Vercel with a team account) and comments here on
  sign-off, then engineering finishes it through analysis, a pull request,
  and merge. On a requested pull request (the handoff skill's "A requested
  pull request"), it reads instead: "Next: <the person who ran the session, by full name> takes this
  through review and merge in the pull request handoff opens from this
  branch." The ticket stays assigned to them.

## Design Review

<Filled only at handoff from verified final diff, publication receipts and
actual evidence, not the private technical plan. No invented copy or technical
approval request to the Vibe coder. Record source-backed reasons for unavailable
surfaces; never invent a preview or inspection.>
- App and Storybook previews: <exact verified links, full deployed commit,
  verification evidence/time and protection/access status. For an owned
  prototype, use its canonical immutable preview and truthful unavailable/N/A
  app or Storybook surfaces; no credentials or private Desktop bridge URL.>
- Scope and coverage: <requested scope, screens, hosts and states; identify
  actual runtime/visual inspection separately from source-only and unverified.
  Reference the Handoff Production impact and Flag changes and gates evidence,
  keeping conditional production effects separate from this Storybook inventory.>
- Storybook inventory: <added/changed/removed components and stories with paths,
  IDs and direct links, each `<storybook-base>/?path=/story/<story-id>` and
  never the bare `iframe.html` canvas (`environment.md`, "Storybook links"); controls, Docs and plays as declared versus actually
  inspected/executed; intentional ID/category moves and sidebar folds with
  old/new IDs and retained state access. Removed/unavailable links are identified
  honestly, never fabricated.>
- Footprint and catalog: <actual footprint baseline/current commits, command
  and report links, canonical catalog/check evidence and unresolved advisories;
  source inspection alone does not clear a compiled warning.>
- Visual evidence: <actual design/visual-QA reports and screenshots, with
  commits, viewports/dimensions, hosts and states inspected, including the
  `pnpm control` captures from the Handoff Running app checks: each touched
  screen and host with its screenshot embedded and what it proves, before and
  after when a baseline exists. Separately list
  source-only, unverified, failed or unsupported coverage, with the exact
  control command and reason for a surface control could not drive.>
- Limits and decisions: <known gaps, remaining design decisions and owners;
  do not say looks good or Storybook correct without actual inspection/check
  evidence. Preserve existing required visual/product approval gates.>
- Design conflicts: <each `design` conflict from the change log: what
  disagreed, how the session decided it, and the evidence (doc section or
  precedent paths)>, or "None"

## Grading

Whoever picks this up grades it at pickup, before changing anything: design
when it is assigned to them, engineering when design passes it on, before
opening the PR. Set your field, `Design grade` or `Eng grade` (High / Medium /
Low), in the issue's Custom Fields section below the body (it starts
collapsed), then post one comment using the template below. When the PR
merges, engineering adds what had to be fixed before merge.

High = took it as is or with small tweaks. Medium = real fixes, but we kept
the structure. Low = had to redo a meaningful part.

```
Grade: High / Medium / Low

Yes / no, plus one line when it's a no:
1. Followed our codebase rules. AGENTS.md and the nearest owning AGENTS.md, no lint or gate suppressions added to get green.
2. Reused existing components. No hand-rolled copy of something we already ship, and no duplicated helpers or types.
3. Storybook is right. Every new or changed component has stories in the right place, and the controls are usable. (Design)
4. Extended the existing pattern. For example, behavior the children of a shared parent share built once in that parent so each gets it, not one copy per child.
5. Backend is wired correctly. Route, service, shared types, Zod and migration follow our layering, and nothing is left on a stub. (Eng)
6. No invented copy. Every user-visible string came from a person or an existing label, and nothing agent-written went into product docs pages.
7. What we had to fix before merge. A count and a short list. (Eng, filled in at merge)
```

## Engineering checklist

- [ ] Review the backend listed under Backend built and finish anything under
      Backend still missing
- [ ] Write the tests listed under Missing tests in the Handoff section,
      and a test for every frozen row, in the pull request
- [ ] Decide whether a net-new surface needs a default-off PostHog flag before
      merge (closed-by-default UI policy)
- [ ] Verify shared UI package changes on both web and Desktop
- [ ] Open the pull request to `main`; independent code review
````
