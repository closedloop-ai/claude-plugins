# Provider text for agents/vibe-setup-worker.md

Each block replaces the stub of the same id there, in a session bound to this provider.

<!-- block: read-first -->
`../skills/vibe/references/preflight.md`, `../skills/vibe/references/environment.md`,
and `provider:closedloop-graph.md`. Use closedloop-graph
first: `fts_search` for an unfamiliar error to find known setup problems and
open tickets, and `blast_radius_tickets` on a file you suspect.
<!-- end: read-first -->

<!-- block: connection -->
- ClosedLoop or closedloop-graph unreachable: ClosedLoop's `get-me` failed,
  or closedloop-graph's `sync_status` failed or a worker's Graph block said
  `unreachable`. This is a setup problem, not a normal state. Follow
  `preflight.md`, "Restoring a connection", exactly: you run every command,
  and the person only signs in in the browser, returned as `NEEDS_PERSON`
  with that section's exact words; whether a new chat is needed is the
  orchestrator's step 5, never yours. A launch the
  Claude worker launcher refused with `MCP_TOOLS_MISSING` names the
  connection that did not load. Never send the person into the app's
  Settings and never use Computer Use.
<!-- end: connection -->

<!-- block: auth-keys -->
- Real Clerk sign-in stack (for example `just dev`) needed and `local.env` has
  no Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` or `CLERK_SECRET_KEY`
  blank or absent): never fetch or type the secrets yourself. Tell the person
  to run `! just clerk-keys` in the repository (after
  `aws sso login --profile <their stage profile>` if needed), returned as
  `NEEDS_PERSON` in one plain line, then continue. Agent verification stacks
  run Clerk-free and never need this.
<!-- end: auth-keys -->

<!-- block: bootstrap -->
- Bootstrap: run `./.closedloop-ai/loops-setup.sh` in the worktree; on failure
  read its output and fix the cause if it is a missing prerequisite.
<!-- end: bootstrap -->

<!-- block: storybook -->
- Local Storybook: start it detached in the worktree on a free port from 6100
  to 6999, logging to the session's private git directory:
  `nohup pnpm --filter storybook exec storybook dev -p <port> --ci --no-open > "$(git -C "<wt>" rev-parse --absolute-git-dir)/vibe-storybook.log" 2>&1 &`.
  Wait until the log shows its `Local:` line and `http://localhost:<port>`
  answers, then record it, keeping anything else the stack lists:
  `vibe-sessions.mjs touch --worktree "<wt>" --stack '{"storybookUrl":"http://localhost:<port>","storybookPid":<pid>, ...}'`.
  If the stack already lists a Storybook whose process is alive and whose URL
  answers, reuse it.
<!-- end: storybook -->

<!-- block: desktop -->
- Local Desktop (every session), in two dispatches, following the Desktop
  section of `environment.md` exactly (it is the one place the commands
  live):
  - Profile: build the seeded profile in the session's private git directory
    (step 1), make its auth claim and save it with `desktop-auth` (step 2),
    and return `DONE` saying the environment must now be requested again
    (the orchestrator dispatches `vibe-environment-worker` in desktop mode).
  - Launch (also how a stopped Desktop is started again): if
    `vibe-sessions.mjs desktop-tab --worktree "<wt>"` reports `running`,
    return `DONE` without starting a second Desktop on the profile.
    Otherwise sign the profile in (step 4) unless it already is (sign-in
    refuses a signed-in profile; go on to step 5), start the app detached
    (step 5), wait for its `Desktop window visible` log line, and record the
    launch and its tab URL with `desktop-launched` (step 6; a worktree whose
    launcher predates the tab is recorded with no URL and keeps running as a
    window). Return `DONE` once it is recorded; the orchestrator reads the URL
    with `desktop-tab`, so never put the URL or its token in your result.
  - Stopping everything the session runs (it was kept, discarded or handed
    off) is `vibe-sessions.mjs stop --worktree "<wt>"`, never a signal by
    hand: it stops the recorded Storybook and Desktop only after proving each
    is still the session's own process, and leaves a stale or reused pid
    alone. A confirmed `discard` runs it first.
  - Stop Desktop only (before a step that merges main or swaps the
    worktree's commit, per "Never swap the worktree under a running Desktop"
    in `environment.md`): stop the recorded Desktop launch as `environment.md`
    says, wait until its Electron process has exited, and leave Storybook and
    the rest of the stack as they are (`desktop-tab` then reports it not
    running).
  Never point a Desktop at a local API. If a command fails and you cannot fix
  it, return `BLOCKED` with `DESKTOP_UNAVAILABLE` and the error in one line.
<!-- end: desktop -->

<!-- block: discard -->
- Discard (only when the orchestrator says the person confirmed): stop the
  session's processes (as above), then run
  `node ../skills/vibe/scripts/vibe-sessions.mjs discard --worktree "<target-wt>" --confirm`
  from the retained execution checkout, never the target or a child of it.
  It refuses a handed-off session; otherwise, for a pushed session, it
  requests the drop of the session's preview schema and stored files
  (the repository's `cleanup-preview-schemas.yml` workflow through `gh`, since
  nothing removes a `vibe/` schema automatically), then deletes the remote
  `vibe/<slug>` branch, the worktree, and the local branch. A failed
  request deletes nothing. Return `DONE` with the successful script receipt,
  including `discarded: true` and its `cancelEvidence` when it has a live
  ticket. A partial or failed deletion returns `BLOCKED` and grants no ticket
  cancellation. Never manufacture a receipt or delete a branch
  any other way.
<!-- end: discard -->

<!-- block: repo-bug -->
1. Diagnose it: the failing command, the error, the root cause file and line,
   and the smallest fix. Check closedloop-graph (`fts_search` on the error,
   `blast_radius_tickets` on the file) and ClosedLoop `search` for an open
   ticket that already reports it; if one does, use that ticket and do not
   file another.
2. Otherwise file a ClosedLoop ticket with `create-document` (`type: ISSUE`):
   assigned to the vibe engineering owner (ClosedLoop user id
   `019c24dc-63ca-717e-b057-ce589da3d2e1`; confirm it in `list-users`), in the current week's project from
   `list-projects` (the date-range name covering today), with a plain title
   and a body holding the diagnosis: the base commit
   (`git -C "<wt>" rev-parse HEAD`), the failing command, a short error
   excerpt, the root cause and the session slug. Never fabricate an applied fix.
3. Return the diagnosis and ticket to the orchestrator. The SAME persistent
   writer makes the smallest managed local workaround in this session worktree
   only, never the main checkout, commit, push or stash. It records every changed
   or added file with `vibe-sessions.mjs local-fix`, under this bug ticket and
   during its exclusive record turn. No redeploy or handoff commits these files.
   Setup never authors the correction or registers another coding worker.
4. Add the writer's verified local diff to the diagnosis through the granted
   ticket record turn. The ticket retains ownership of the permanent correction.
5. Retry the operational launch after the writer supplies the verified workaround
   and confirm it answers. Preserve all existing local-fix exclusion and restore
   rules, including historical `localFixes`.

If the failure is not in a session worktree (for example the main checkout's
bootstrap), file or reuse the ticket and return `BLOCKED` with its slug; do
<!-- end: repo-bug -->
