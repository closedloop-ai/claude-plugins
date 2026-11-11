# Provider text for skills/vibe/SKILL.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: root-may -->
- You may talk to the person; run this skill's scripts
  (`scripts/vibe-preflight.sh`, `scripts/vibe-sessions.mjs`,
  `scripts/commit-worktree.mjs`, `scripts/local-plans.mjs`,
  `scripts/session-questions.mjs`, `scripts/run-bounded.mjs`,
  `scripts/dist/writer-state.mjs`, `scripts/dist/claude-worker.mjs`,
  `scripts/plugin-version.mjs`, `scripts/precedent-check.mjs`); run
  `plugin-version.mjs update` only when the person chose to update;
  call ClosedLoop `get-me`
  and closedloop-graph `sync_status` (and, in Claude Code, a connection's own
  `authenticate` tool as `references/preflight.md`, "Restoring a connection",
  says); inspect the in-app browser for live-Asana
  precedent or accepted visual QA (`references/quality-loop.md`); and dispatch.
<!-- end: root-may -->

<!-- block: brief-auth -->
- Every worker brief says: after the first authentication failure, use CI logs
  or the API for the same fact, or stop and ask; never write, export or route
  around credentials. On a machine without the staging e2e identities the
  local web e2e lane is never run, so its sign-in failure never happens: it is
  recorded not run and the containerized or CI run covers it
  (`scripts/pre-pr-lanes.mjs`; operator ruling, 2026-10-28). Never force-push; this covers every remote. Proof and
  scratch commits use a fresh `proof/<sha>-<n>` ref.
<!-- end: brief-auth -->

<!-- block: product-research -->
Research product questions in the single order in `references/quality-loop.md`.
When the first five sources do not settle the question, the next action is live
Asana; do not stop at the product owner's recorded direction. Interrupt only
for one necessary unresolved question with full context. Never re-ask a settled
decision; a decision is settled only when it traces to a human statement
(`references/quality-loop.md`, "Communication and product questions").
<!-- end: product-research -->

<!-- block: graph-required -->
- Every worker reads `provider:closedloop-graph.md`. closedloop-graph is
  required: workers that locate, change, or review code make its required
  calls for every non-trivial request and end their result with a Graph
  block listing each call and what it established. When you dispatch one,
  say so in the brief. A non-trivial result without a Graph block, or with
  one that lists no calls, is incomplete: dispatch the worker again saying
  the Graph block is missing. A Graph block that says `unreachable` keeps
  that change moving; dispatch `vibe-setup-worker` to restore the
  closedloop-graph connection before the next change.
<!-- end: graph-required -->

<!-- block: live-ticket-template -->
- Every worker that edits the live ticket follows
  `provider:ticket-template.md`. Say so in the brief and give the slug.
<!-- end: live-ticket-template -->

<!-- block: requirements-row -->
| `vibe-requirements-worker` | read a ClosedLoop ticket (and its PRD, plan, related tickets) or a description and turn it into a brief, plus the route and FEATURE_MAP id where the relevant code lives, for change workers; in reference mode, research an outside product the person named and list the behaviors to build |
<!-- end: requirements-row -->

<!-- block: ticket-row -->
| `vibe-ticket-worker` | create the session's live ticket and link the document it started from, publish the session's plan as its PLN after each request, and fill its record sections when you ask |
<!-- end: ticket-row -->

<!-- block: environment-row -->
| `vibe-environment-worker` | stand up the session's Vercel environment, redeploy it, or refresh its flag snapshot |
<!-- end: environment-row -->

<!-- block: prerequisites-posthog -->
Run `scripts/vibe-preflight.sh --prototype` for the common prerequisites
before choosing a session. This defers the app's PostHog key check until
section 2 identifies the session. For an app session, re-run the default
`scripts/vibe-preflight.sh` and resolve its failures before section 3.
Pure mockups and recorded prototype resumes need no PostHog key.
<!-- end: prerequisites-posthog -->

<!-- block: connectors -->
Also confirm the two connectors answer: ClosedLoop (`get-me`) and
closedloop-graph (`sync_status`). closedloop-graph is required. If either
does not answer, dispatch `vibe-setup-worker` to restore that connection
(`references/preflight.md`, "Restoring a connection"); never ask the person
to set anything up beyond what that worker reports as `NEEDS_PERSON`. On
Codex, send the one heads-up line from `references/preflight.md`, "Commands
the sandbox blocks", before you dispatch it for a sign-in (ClosedLoop or
GitHub), and when a worker says the sandbox refused a sign-in command,
dispatch it again to rerun that command with an escalation request, never
handing the command to the person. When it
returns `DONE`, do that section's step 5 yourself: call the tool again in
this chat and carry on when it answers. Ask for a new chat only when it still
fails or the connection was just added, never as a precaution.
<!-- end: connectors -->

<!-- block: new-words -->
- Their own words already say new: a ClosedLoop ticket, or a description of
  new work. Go to "Starting new" below without asking.
<!-- end: new-words -->

<!-- block: pln-executed -->
Before offering anything, for each `handed-off` session whose
`livePlanStatus` is `APPROVED`, dispatch `vibe-ticket-worker` in plan mode
with `mergeCheck: true` (its own record turn): when the session's pull
request has merged it moves the PLN to `EXECUTED`. This is internal; never
mention it to the person.
<!-- end: pln-executed -->

<!-- block: start-new-first -->
1. Your first reply to the new session carries the endings line (section 5,
   "Notices that never wait"), after the plugin version check (section 1,
   "Plugin version"): when the version is current or unknown it goes in the
   very first reply; when it is outdated and the opening message did not
   already say to proceed, the version question comes first on its own and the
   endings line goes in the first reply after the person answers it. An
   opening instruction to proceed reports the version and continues, so it
   does not delay this line or the work. Use the work the person already described.
   Only when they have not supplied it, ask what they want to work on: a ClosedLoop ticket (ISS-, PRD-, or a pasted
   URL) or a plain description. If they clearly want a mockup or an
   exploration with made-up data, start the prototype session below yourself. The person only types `$vibe` and
   `$handoff`; do not ask them to invoke `$prototype`. For a
   ticket, dispatch `vibe-requirements-worker`. For a description, dispatch
   the same worker with the description: it checks for an existing ticket
   covering it. Before creating the session, use the validated `<repo>` with
   `sessionless: {kind: "startup"}`, mode `request`, graph/live read capabilities
   and no record grants. Keep its brief internal; no upfront summary or plan approval.
   Keep its quoted acceptance criteria from the ticket and its PRD for the
   writer's first request (`references/quality-loop.md`, "Acceptance criteria
   before ready"), as the draft Spec Card (`references/spec-card.md`). When the source is a PRD, its existing children are the
   scope units: the requirements brief classifies every child before the
   session ticket exists, and the ticket worker claims or reports them
   (`vibe-ticket-worker.md`, create step 7).
   Its route and FEATURE_MAP id are for workers; never present them as the
   starting screen or promise a screen for a broad request.
<!-- end: start-new-first -->

<!-- block: starting-data -->
2. Choose the app's starting data. Use what the person already said. The
   choice goes through the same necessity gate as any other question
   (`references/quality-loop.md`, "Communication and product questions"): it
   matters only when the request is about what a new, empty account looks
   like (first-run screens, empty states, setting up an organization). In
   every other case record `seeded` and ask nothing. When it does matter,
   ask once, in these words: "Should your copy of the app start with an
   example company that already has people and work in it, or start empty so
   you can set it up yourself?" Record `seeded` or `blank`; if they are
   unsure, use `seeded`. Never name the example company after the person's
   email or anything else of theirs; call it "the example company".
<!-- end: starting-data -->

<!-- block: session-new -->
4. `node scripts/vibe-sessions.mjs new --slug <slug> --summary "<one line>"
   --mode <seeded|blank> [--ticket <slug>] [--repo <checkout>] [--worktree <path>]
   --operator-id <id> --operator-email <email> --operator-name "<firstName lastName>"`,
   passing the `--repo` and `--worktree` a fleet brief names (the worktree
   must be `<checkout>/.claude/worktrees/vibe-<slug>`; `new` refuses a
   `--repo` of another repository),
   with the operator from the `get-me` call in section 1 (the person running
   this session; leave out `--operator-name` when `get-me` has no name). This
   fetches main and creates the worktree on `vibe/<slug>` from fresh
   `origin/main`. The live ticket is assigned to that person. If it refuses
   because the slug is taken, derive a different slug and run it again;
   never search previous sessions to resolve it.
<!-- end: session-new -->

<!-- block: bootstrap-ticket -->
6. Dispatch `vibe-setup-worker` to bootstrap the new worktree. Read the
   `session` returned by `vibe-sessions.mjs new`. When the returned
   `session.liveTicket` is the originating issue, do not dispatch
   `vibe-ticket-worker` and never queue `create` mode: the session record is
   already bound to that issue, preserving its current owner and status.
   Otherwise dispatch the
   ticket worker in create mode with the worktree, the requirements worker's
   brief, the originating document if any, and the mode. Create mode records
   the new issue's slug on the session and links the originating document (a
   PRD, an ISS or another document) to the ticket (source PRODUCES ticket).
   Keep the ticket link in the session record for completion and handoff.
<!-- end: bootstrap-ticket -->

<!-- block: resume-push -->
Resuming: use the session's `worktree`, and run the matching `codex-sessions`
or `claude-sessions` command again so a
new conversation is recorded too. Existing tickets use quality-loop's plan
rule. A resumed session gets no endings line. Starting new or resuming stops any other
session's local Storybook or Desktop (dispatch `vibe-setup-worker` to stop
what that session's `stack` lists) but never touches its files. You commit
only through `scripts/commit-worktree.mjs` and never push, stash, or rebase;
only `vibe-environment-worker` pushes, when a change deploys (section 6).
<!-- end: resume-push -->

<!-- block: desktop-swap -->
Desktop's screens reload live from the worktree, so merging main into it, or
any other swap of its commit, while Desktop runs crashes the Desktop tab
("Never swap the worktree under a running Desktop" in
`references/environment.md`). The main-sync publication sequence does this
only after stopping the owned Desktop. On `NEEDS_DESKTOP_STOP`, dispatch
`vibe-setup-worker` to stop Desktop, dispatch the worker again, then start
Desktop again and open its new tab (section 3, Desktop step 2 then step 3).
<!-- end: desktop-swap -->

<!-- block: environment -->
Before FIRST publication, register/resume the SAME implementation writer under
section 5's actual identity/hold/lease rules, not a new bootstrap source actor.
ROOT commits the checked deliverable LOCALLY under normal hooks, still unpushed,
before `commit-worktree.mjs --prepare-main-sync`; if no deliverable changed,
no extra commit is needed. Protected dirty localFix source remains preserved/blocking.
Apply `references/environment.md`, "Main-sync before publication" (one
`main-sync-inputs` pass, after the merge commit); no stale interim raw push.

Dispatch `vibe-environment-worker`
in create mode with the worktree, the live ticket slug, the mode, and
`references/environment.md` and matching transaction/context. It preserves
flag snapshot rules, pushes the explicit validated SHA through the gate,
starts the environment through GitHub, follows it to the end, records
the URLs on the session, and fills the ticket's Environment, Production flag
snapshot, and Sessions sections.

A resumed session whose `vercel.verifiedAt` is set already has its
environment; skip this and use its recorded `appUrl`, opening
`<appUrl>/sign-in` first as below. A resumed session
without it (one started before environments were verified) goes through
create mode again; the worker keeps its flag snapshot. If the worker returns `NEEDS_PERSON` asking which of
the person's organizations should hold the example company, ask the person exactly its question, record the org
id the worker mapped to their answer with
`node scripts/vibe-sessions.mjs touch --worktree "<wt>" --clerk-org-id <org_...>`,
and dispatch it again. If it returns `NEEDS_PERSON` saying they are not an
admin of any of their organizations, pass that on as written and wait for
their answer. If it returns `BLOCKED`, tell the person in one or two
plain lines what failed and which supported recovery or handover you are
taking (`references/guardrails.md`, "Plugins and tooling"). Never open or
give the person a URL after `BLOCKED`: any
preview address without its own deployment shows the stage production app.

When it returns `DONE`:
- Open `<appUrl>/sign-in` (the `appUrl` it returned, verified against the
  branch's own deployment) in a Codex in-app Browser tab and make the browser
  visible, since the root sends a signed-out visitor to account creation.
  Later, use the plain `appUrl`, or `<appUrl>/sign-in` if a tab lands on
  account creation. The person signs in through Clerk as themselves (you
  never type credentials). Seeded: they land in the example company as an admin. Blank: they create
  their own org.
- Confirm the tab shows the app (with seeded data when seeded), not an error
  page or an empty shell, before saying it is ready.
- Start Desktop for every session, per the Desktop section of
  `references/environment.md`, unless the manifest's `desktop` step has
  `effective: skip` (`references/triage.md`, "The switch"; off by default), and
  open it as a second tab:
  1. Run `node scripts/vibe-sessions.mjs desktop-tab --worktree "<wt>"`. If it
     reports `running`, skip to step 3.
  2. If the session has no Desktop profile yet (`desktopAuthSavedAt` is null
     in `vibe-sessions.mjs show`), dispatch `vibe-setup-worker` to build the
     profile, then `vibe-environment-worker` in desktop mode (in a blank
     session, only after the person has signed in and created their org),
     then `vibe-setup-worker` to sign it in and launch it. If it has one,
     dispatch `vibe-setup-worker` to launch it. The launch returns `DONE`
     once Desktop reports ready and its tab's URL is recorded; run
     `desktop-tab` again for that URL.
  3. Open its `url` exactly as given (never shortened, never shown to the
     person) in a second Codex in-app Browser tab, and confirm it shows the
     Desktop app's navigation, not `Connecting to Closedloop Desktop…`, an
     error, or a refused connection. `running` with no `url` means the
     worktree predates the tab: Desktop is its own window, with no tab to open.
  If a step returns `DESKTOP_UNAVAILABLE`, tell the person "Desktop isn't
  available for this session yet, so we'll keep going on the web app." and
  continue web-only.

If setup diagnoses a repo bug that stops local startup, route its ticket and
evidence to the SAME persistent writer for the managed local workaround in
`quality-loop.md`. Keep the diagnosis and ticket internal. The sole writer
records every changed file as a local fix; no redeploy or handoff commits it.
Setup only retries the launch after that verified correction, never patches code.

### Bringing a tab back

When the person asks to reopen the app or Desktop, open a new tab for it:
- The web app: the plain `appUrl` (`<appUrl>/sign-in` if it lands on account
  creation).
- Desktop: run `node scripts/vibe-sessions.mjs desktop-tab --worktree "<wt>"`.
  If it reports `running`, open its `url` exactly as given. Otherwise Desktop
  quit, was stopped, or never started: start it as in step 2 above, then open
  the new `url`. `DESKTOP_UNAVAILABLE` and `running` with no `url` are
  handled as in step 3 above. Never open a Desktop URL from an earlier launch
  or a tab's address bar; each launch has its own.
<!-- end: environment -->

<!-- block: labs-placement -->
For a net-new screen or capability, have the requirements worker research its
existing product rulings first. Only if the placement remains absolutely
necessary and unresolved, ask once: "Should this go in Labs, or straight into
the app?" Default to straight into the app when no unresolved decision is needed.
<!-- end: labs-placement -->

<!-- block: request-forward -->
1. When the person attached an image or gave one as a file path, first save
   it: `node scripts/reference-images.mjs attached --worktree "<wt>"
   --request-id <id>` (or `save --file <path>`), which records it on the
   session. Forward the person's request/annotation verbatim, session/branch, live
   ticket, known rulings and supplied copy to the SAME writer, plus, with the
   first request, the requirements worker's quoted acceptance criteria, and
   every saved reference image path. Never send your own description of an
   image in place of its path. It performs
   graph/owner prep and writes the canonical core-template plan locally.
   It locks the Spec Card before any code (`references/spec-card.md`). It
   always creates or extends the one session decision table at
   `.closedloop-ai/decision-tables/<session-slug>.md` before any code, using
   the named core skill in quality-loop.md. Include its path and affected/
   interacting row IDs in every applicable worker brief. Later requests append
   to this same artifact with provenance; no per-request table or history reset.
   No upfront summary, technical question or plan approval reaches the person.
   When the request names an outside product as its reference, or gives a
   screenshot of one, the reference-product notice below runs first and its
   list goes to the writer with the request.
<!-- end: request-forward -->

<!-- block: implement-order -->
3. The writer implements in dependency order. It can load canonical
   backend, primitive, prototype and Storybook guidance from its own plugin,
   but no new source writer/worktree/branch. Read-only specialists advise;
   their findings return to this writer. Preserve real visual/product approvals.
   Before it creates, retitles or moves a story or adds a shared component,
   it returns `NEEDS_STORYBOOK` with the capability and planned files;
   dispatch read-only `vibe-storybook-decomposer` in placement mode and resume
   the SAME writer with its Placement block, which the writer records in its
   local plan before writing. That block is a read-only lookup in quick prep,
   not a review. The writer logs a Conflict in it with its audience, `design`
   or `engineering`, for the live ticket (`provider:ticket-template.md`,
   "Conflicts"), never a question for the person.
   A part that needs a path the writer may never edit is logged as
   `Engineering needed (forbidden path)` for the live ticket's Engineering
   checklist while the writer builds the rest (`references/guardrails.md`,
   "What may change"); it never stops the request and is never a question
   for the person.
   When its plan needs NEW Storybook components, it builds them first and
   returns `STORIES_READY`; send the new-components notice below and resume
   it at once to build the feature.
<!-- end: implement-order -->

<!-- block: record-pln -->
6. Record scope/progress/backend facts through the writer's explicit serial
   record continuation or the authorized ticket helper, never simultaneously.
   Once the writer's turn ends with a plan written for the request (`DONE`,
   or a stop such as `NEEDS_PERSON` or `BLOCKED` before the build finished),
   dispatch `vibe-ticket-worker` in plan mode in its own record turn, with
   `built: true` when the request is `DONE` and `built: false` otherwise. It
   publishes the session's plan as its one PLN, linked from the live ticket,
   appends a version only when the plan changed materially, and sets the
   PLN's status. Its `NEEDS_CHANGE` (a plan line
   that would publish a local path, a username, a secret or a private input)
   goes to the SAME writer to fix its local plan, then plan mode runs again.
   A repair only to vibe's private plan or records, with no scope, code, test
   or HEAD change, is `self-bookkeeping`: the writer makes it automatically,
   it is never `NEEDS_PERSON`, and Root reports it in one line. None of it
   waits on or reaches the person, and it never delays the deploy.
   A plan's body never goes into the ticket. Operational bootstrap/build/deploy helpers
   execute no implementation edits, and sharing waits for the writer's quick
   checks. The orchestrator alone commits through its owned script.
<!-- end: record-pln -->

<!-- block: deploy -->
The orchestrator deploys every change in the build loop without being asked:
as soon as the writer finishes a request
(section 5, step 7), commit and deploy it to the session's Vercel preview with
the steps below, then tell the person it's ready to look at. The person no
longer has to say "redeploy"; when they do say "redeploy", "redeploy to
Vercel", "push it up", "put it on Vercel", "let me see it live", or anything
meaning the same, run these same steps.

One deploy runs at a time. Requests that arrive while a deploy is running wait
in the writer's queue until it finishes; then the writer builds every request
that waited, and one deploy after the last of them carries them all. A
"redeploy" said during a running deploy joins that next deploy.

1. Run the matching `codex-sessions` or `claude-sessions` command from step 5 so
   the ticket lists every subagent so far.
2. Keep deployment progress internal; report completion, not technical steps.
   After the writer's quick checks, ROOT commits the checked deliverable
   LOCALLY with the existing commit script and normal hooks, still unpushed. Then the
   publishing helper runs `commit-worktree.mjs --prepare-main-sync`; no
   operational helper regenerates dependencies. Before any remote push
   follow `references/environment.md`, "Main-sync before publication".
3. After preparation and SAME-writer conflict/source correction, ROOT commits
   the staged ordinary merge and any checked fixes (nothing is pushed yet):
   `node scripts/commit-worktree.mjs --worktree "<wt>" --subject "<live ticket slug>: <plain imperative summary of the changes since the last redeploy>" --body "<the screens changed, one per line>"`.
   The subject stays under 72 characters and never mentions AI tools. The
   script leaves out the session's `localFixes` and files that never belong
   in a commit, and the repository's commit hook runs. Add `--exclude <path>`
   for each untracked file the inventory lists as `forbidden` or
   `outsideAllowed` that the session did not write (a person's own files);
   the commit goes ahead without them and without asking anyone to move them. `committed: false`
   means nothing changed; continue. `"ok":false` means the hook refused:
   resume the SAME persistent writer in fix mode with the error, then commit
   again. An existing test or fixture the change broke is repaired there
   (`references/guardrails.md`, "Repair, don't author"). When the writer
   returns `BLOCKED` because a test of live behavior would need changed
   assertions, first check the alternative paths in `references/guardrails.md`,
   "Plugins and tooling". If the block remains, record the exact cause and
   tried paths, then offer the supported pushed handover. Never ask the person
   to repair the test.
4. Dispatch `vibe-environment-worker` in redeploy mode with the worktree, the
   live ticket slug, the session summary, and the session's `localFixes`
   paths. First resume that SAME writer's source-owned `progress` continuation
   to run `main-sync-validate` against committed inputs. The later publisher
   grant carries captured `mainSyncTransactionId`, build purpose and actual
   stdin context. It pushes only the admitted SHA, requests the environment again so that commit is
   deployed, and updates the ticket. The quick checks have run in the
   loop; no tests are authored.
5. On `DONE`, reload the app tab (and the Desktop and Storybook tabs if
   open), look at it yourself, and tell them it's ready to look at, with a
   link to each changed page or component (`references/plain-words.md`,
   "Links to what the person should look at"), naming plainly any acceptance criterion still `not met yet` (section 5,
   step 7). When the session has a reference image, look at each touched
   screen beside it first: a visible difference is not ready, so resume the
   SAME writer with it and redeploy before saying ready. Never say it
   matches the reference when you have seen a gap
   (`references/quality-loop.md`, "The reference check before ready" and
   "What the orchestrator says"). Whenever you open
   the Vercel `storybookUrl` and the tab lands on `vercel.com` (a Vercel sign-in or
   `sso-api` page) instead of Storybook, tell the person plainly: "The
   component gallery needs you to sign in to Vercel with your team account first."
   Do not try to get around it. When this deploy is a visible milestone
   (the first user-visible change ready to look at, or a later major visible
   change; never a small edit), the ready message also offers visual QA,
   without waiting for the person to think of it; on yes, run it. When the
   person says it looks good and wants it polished, run visual QA before
   handoff without asking, unless the change shows nothing visible or they
   already declined it for this version. The offer's words, its
   `session-questions.mjs` key, what the check compares against and where
   its findings go are in `references/quality-loop.md`, "Visual QA during the
   session". On `BLOCKED` because the repo's checks
   refused the push or a build failed in the session's own change, dispatch
   the SAME persistent writer in fix mode with the failure, then rerun its
   quick checks before committing and redeploying again (steps 3 and 4). Keep the repair details internal.

Never deploy a change before the writer's quick checks pass.
<!-- end: deploy -->

<!-- block: flag-snapshot -->
The environment uses the production flag values captured when it was created
(on the ticket under Production flag snapshot). If the person asks to refresh
the flags or to match production again, dispatch `vibe-environment-worker` in
flags mode with the worktree and the live ticket slug. Never refresh them
otherwise.
<!-- end: flag-snapshot -->

<!-- block: keep-it -->
On "keep it", stop local Storybook and Desktop with
`node scripts/vibe-sessions.mjs stop --worktree "<wt>"`, which signals only a
recorded process it proves is still the session's own. Their work stays in the worktree and on the branch until they
come back and say they are done; remind them that is how it gets a pull
request or reaches design and engineering. On "throw it away", follow section 9.
<!-- end: keep-it -->

<!-- block: discard-lost -->
2. Tell them in plain words what will be lost (the session's summary, its
   unsaved files, and their Vercel copy of the app and its data). When
   `liveTicketCreatedBySession` is true, also say that session-created ticket
   is canceled. A bound pre-existing ticket is not canceled or reassigned.
   Ask them to confirm.
<!-- end: discard-lost -->

<!-- block: discard-run -->
3. On a clear yes, retain the validated remembered `<repo>` separately from
   the target `<wt>` and the parent-held preview's branch, live ticket and
   operator. Dispatch `vibe-setup-worker` from that stable `<repo>` with
   `sessionless: {kind: "startup"}`, mode `record`, `recordAction: "discard"`,
   `exclusiveRecordTurn: true`, graph/live reads only, and `discardTarget`:
   `{worktree: "<wt>", confirmed: true, branch, operatorId, operatorEmail}`
   plus `liveTicket` and `liveTicketCreatedBySession` when present (`references/quality-loop.md`,
   "Exactly four helper paths"). The worker stops the session's local
   processes, requests the drop of the session's app data (nothing removes it
   automatically), deletes the worktree and the local and remote branch, and
   returns the script's receipt.
<!-- end: discard-run -->

<!-- block: discard-cancel -->
4. Only after that successful result has `discarded: true`, retain its
   `cancelEvidence` in the parent. If it names a ticket with
   `liveTicketCreatedBySession: true`, dispatch
   `vibe-ticket-worker` from the retained `<repo>` in mode `record`, action
   `cancel`, with `exclusiveRecordTurn: true` and
   `sessionless: {kind: "discarded", evidence: <cancelEvidence>}`, granting
   only parent-discovered graph/live reads and the declared cancel writes. A
   failed or partial discard blocks cancellation. Without that evidence,
   leave the bound ticket's status and owner untouched.
<!-- end: discard-cancel -->

<!-- block: ref-graph -->
- `provider:closedloop-graph.md`: how every worker uses closedloop-graph.
<!-- end: ref-graph -->

<!-- block: ref-environment -->
- `references/environment.md`: the Vercel environment, the flag snapshot,
  redeploys, and what runs on this Mac.
<!-- end: ref-environment -->

<!-- block: ref-ticket-template -->
- `provider:ticket-template.md`: the live ticket's sections and who keeps
  each one current.
<!-- end: ref-ticket-template -->
